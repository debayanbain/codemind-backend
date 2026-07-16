import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { TokenUsage } from '../types/token-usage.types';

export interface LlmCompleteParams {
  system: string;
  user: string;
  anthropicModel: string;
  openaiModel: string;
  maxTokens: number;
}

export interface LlmCompleteResult {
  text: string;
  usage: TokenUsage;
}

/**
 * Models that accept `thinking: {type:'adaptive'}` and `output_config.effort`.
 *
 * This is not a style preference — Haiku 4.5 rejects both with a 400, which
 * kills the agent outright rather than degrading it. Verified against the live
 * Models API: `claude-haiku-4-5` reports `capabilities.thinking.types.adaptive`
 * and `capabilities.effort` as false, `claude-sonnet-4-6` reports both true.
 *
 * Prefix-matched, and an unknown model is treated as NOT supporting them. A
 * model that thinks less produces a thinner report; a model that 400s produces
 * no report at all, so the safe default is the quiet one.
 */
const ADAPTIVE_THINKING_MODEL_PREFIXES = [
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-fable-5',
];

export const supportsAdaptiveThinking = (model: string): boolean =>
  ADAPTIVE_THINKING_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));

/** One turn of a tool-use conversation. */
export interface LlmConverseParams {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.ToolUnion[];
  maxTokens: number;
  /** Force a specific tool. Used to make the last turn emit the result. */
  toolChoice?: Anthropic.ToolChoice;
  /**
   * Sonnet 4.6 runs *without* thinking when the field is omitted — it has to be
   * asked for explicitly. Adaptive also auto-enables interleaved thinking, which
   * is what lets the model reason between tool calls rather than only up front.
   */
  thinking?: boolean;
  /** Sonnet 4.6 defaults to `high`; we pay for that unless we say otherwise. */
  effort?: 'low' | 'medium' | 'high' | 'max';
}

export interface LlmConverseResult {
  stopReason: Anthropic.Message['stop_reason'];
  content: Anthropic.ContentBlock[];
  usage: TokenUsage;
}

// Provider toggle for local testing without an Anthropic key — the fixed
// architecture (CLAUDE.md) is Anthropic Haiku/Sonnet; this is an escape
// hatch, not a replacement. Default stays anthropic.
@Injectable()
export class LlmClient {
  private readonly logger = new Logger(LlmClient.name);
  private readonly provider: 'anthropic' | 'openai';
  private readonly anthropicClient?: Anthropic;
  private readonly openaiClient?: OpenAI;

  constructor() {
    this.provider =
      process.env.LLM_PROVIDER?.toLowerCase() === 'openai'
        ? 'openai'
        : 'anthropic';

    if (this.provider === 'openai') {
      this.openaiClient = new OpenAI();
    } else {
      this.anthropicClient = new Anthropic();
    }
    this.logger.log(`LLM provider: ${this.provider}`);
  }

  async complete(params: LlmCompleteParams): Promise<LlmCompleteResult> {
    if (this.provider === 'openai') {
      const response = await this.openaiClient!.chat.completions.create({
        model: params.openaiModel,
        max_tokens: params.maxTokens,
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.user },
        ],
      });

      return {
        text: response.choices[0]?.message?.content ?? '',
        usage: {
          input: response.usage?.prompt_tokens ?? 0,
          output: response.usage?.completion_tokens ?? 0,
        },
      };
    }

    const response = await this.anthropicClient!.messages.create({
      model: params.anthropicModel,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: [{ role: 'user', content: params.user }],
    });

    return {
      text: extractText(response.content),
      usage: readUsage(response.usage),
    };
  }

  /**
   * One turn of a tool-use conversation. Anthropic only.
   *
   * `complete()` takes `{system, user}` and hands back `{text, usage}` — a shape
   * that cannot express tools, `tool_use` blocks, `tool_result` blocks, or
   * `stop_reason`. The agent loop is keyed on `stop_reason === 'tool_use'`, so it
   * needs the real message surface, not a flattened string.
   *
   * The OpenAI escape hatch stays on `complete()` and stops here: the loop is
   * Anthropic-shaped, and CLAUDE.md fixes the LLM as the Anthropic API. Failing
   * loudly at the call site beats silently degrading an agent to one shot.
   */
  async converse(params: LlmConverseParams): Promise<LlmConverseResult> {
    if (this.provider !== 'anthropic') {
      throw new Error(
        `The agent tool loop requires LLM_PROVIDER=anthropic (currently "${this.provider}"). ` +
          `The OpenAI escape hatch only supports single-shot completion.`,
      );
    }

    // Sonnet 4.6 accepts adaptive thinking and `output_config.effort`, but
    // @anthropic-ai/sdk 0.111.0 — the newest published build — still types
    // `thinking.type` as "enabled" | "disabled" and has no `output_config` at
    // all. Both fields serialize into the request body either way, so cast the
    // body rather than downgrade the request to match the stale types.
    // Haiku 4.5 has neither adaptive thinking nor `effort`, so the request has
    // to be shaped per model. Omitting `thinking` entirely is how a non-adaptive
    // model is told not to think — `{type:'disabled'}` is an adaptive-era field
    // and isn't worth risking on a model that never advertised it.
    const adaptive = supportsAdaptiveThinking(params.model);
    const body = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages,
      tools: params.tools,
      ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
      ...(adaptive
        ? params.thinking
          ? { thinking: { type: 'adaptive', display: 'omitted' } }
          : { thinking: { type: 'disabled' } }
        : {}),
      ...(params.effort && adaptive
        ? { output_config: { effort: params.effort } }
        : {}),
    };

    const response = await this.anthropicClient!.messages.create(
      body as unknown as Anthropic.MessageCreateParamsNonStreaming,
    );

    return {
      stopReason: response.stop_reason,
      content: response.content,
      usage: readUsage(response.usage),
    };
  }
}

/**
 * Find the text block. Never index `content[0]`.
 *
 * With thinking enabled the first block is a `thinking` block, so `content[0]`
 * is not the answer — reading index 0 yields `''`, `JSON.parse('')` throws, and
 * the caller records an empty result as a success. Concatenate every text block
 * instead: the model may emit more than one, and a block order that changes
 * between models must not be load-bearing.
 */
function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Read all four token classes. `input_tokens` is only the uncached remainder —
 * see TokenUsage. The cache fields are absent on responses that didn't touch
 * the cache, hence the `?? 0`.
 */
function readUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheCreation: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
  };
}
