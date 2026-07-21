import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { TokenUsage } from '../types/token-usage.types';
import {
  AgentProvider,
  CompletionProvider,
  resolveAgentProvider,
  resolveSynthesisProvider,
} from './pricing';

/**
 * Mistral speaks the OpenAI chat-completions dialect, so we drive it with the
 * `openai` SDK pointed at Mistral's base URL rather than pulling in a second
 * vendor SDK. One client library, two hosts.
 */
const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';

// The provider SDKs retry 429/5xx/connection errors with exponential backoff +
// jitter, honouring Retry-After. The default (2) is too few for Mistral's
// low-tier rate limit when five agents and the synthesis call contend for it —
// lift it so later attempts back off far enough for the rate window to reset.
const LLM_MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES ?? 6);

export interface LlmCompleteParams {
  system: string;
  user: string;
  anthropicModel: string;
  openaiModel: string;
  mistralModel: string;
  maxTokens: number;
  /**
   * Override the provider for this one call, independent of `LLM_PROVIDER`.
   * Lets a single feature (e.g. repo chat) run on OpenAI while the synthesis /
   * agents stay on their configured provider. The matching client is built
   * lazily. Omit to use the configured synthesis provider.
   */
  provider?: AgentProvider;
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
  /**
   * Override the provider for this one call, independent of `AGENT_LLM_PROVIDER`.
   * Lets repo chat run the tool loop on OpenAI while the extraction agents stay
   * on their configured provider. The matching client is built lazily. Omit to
   * use the configured agent provider.
   */
  provider?: AgentProvider;
}

export interface LlmConverseResult {
  stopReason: Anthropic.Message['stop_reason'];
  content: Anthropic.ContentBlock[];
  usage: TokenUsage;
}

/**
 * Two independent provider decisions live here, and the split is the point.
 *
 * - `complete()` (single-shot, synthesizer only) runs on `LLM_PROVIDER` —
 *   Anthropic by default, with an OpenAI escape hatch for local testing.
 * - `converse()` (the agent tool-loop) runs on `AGENT_LLM_PROVIDER` — Mistral
 *   for this build, per the approved deviation. The single Sonnet synthesis
 *   call stays on the Anthropic key; the five parallel extraction agents move
 *   to Mistral.
 *
 * They are separate because the two calls genuinely run on different providers
 * at the same time; a single global toggle can't express that.
 */
@Injectable()
export class LlmClient {
  private readonly logger = new Logger(LlmClient.name);
  private readonly synthesisProvider: CompletionProvider;
  private readonly agentProvider: AgentProvider;
  // Not readonly: a per-call `provider` override can lazily build a client the
  // configured providers didn't (e.g. chat forces OpenAI while agents run on
  // Mistral). See ensure* below.
  private anthropicClient?: Anthropic;
  private openaiClient?: OpenAI;
  private mistralClient?: OpenAI;

  constructor() {
    this.synthesisProvider = resolveSynthesisProvider();
    this.agentProvider = resolveAgentProvider();

    // Build only the clients the two active providers actually need. With both
    // on Mistral, Anthropic is never constructed — so a commented-out
    // ANTHROPIC_API_KEY is fine and makes no calls.
    if (
      this.synthesisProvider === 'openai' ||
      this.agentProvider === 'openai'
    ) {
      this.openaiClient = new OpenAI({ maxRetries: LLM_MAX_RETRIES });
    }
    if (
      this.synthesisProvider === 'anthropic' ||
      this.agentProvider === 'anthropic'
    ) {
      this.anthropicClient = new Anthropic({ maxRetries: LLM_MAX_RETRIES });
    }
    if (
      this.synthesisProvider === 'mistral' ||
      this.agentProvider === 'mistral'
    ) {
      const apiKey = process.env.MISTRAL_API_KEY;
      if (!apiKey) {
        throw new Error(
          'A provider resolves to Mistral but MISTRAL_API_KEY is not set. ' +
            'Set MISTRAL_API_KEY, or force AGENT_LLM_PROVIDER / SYNTHESIS_LLM_PROVIDER to anthropic.',
        );
      }
      this.mistralClient = new OpenAI({
        apiKey,
        baseURL: MISTRAL_BASE_URL,
        maxRetries: LLM_MAX_RETRIES,
      });
    }
    this.logger.log(
      `LLM providers — complete()/synthesis: ${this.synthesisProvider}, converse()/agents: ${this.agentProvider}`,
    );
  }

  /** Lazily build (and cache) the client for a provider — used by per-call
   *  provider overrides that the constructor didn't pre-build. */
  private ensureAnthropic(): Anthropic {
    return (this.anthropicClient ??= new Anthropic({
      maxRetries: LLM_MAX_RETRIES,
    }));
  }

  private ensureOpenAi(): OpenAI {
    return (this.openaiClient ??= new OpenAI({ maxRetries: LLM_MAX_RETRIES }));
  }

  private ensureMistral(): OpenAI {
    if (this.mistralClient) return this.mistralClient;
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
      throw new Error('MISTRAL_API_KEY is not set but a Mistral call was made.');
    }
    return (this.mistralClient = new OpenAI({
      apiKey,
      baseURL: MISTRAL_BASE_URL,
      maxRetries: LLM_MAX_RETRIES,
    }));
  }

  async complete(params: LlmCompleteParams): Promise<LlmCompleteResult> {
    const provider = params.provider ?? this.synthesisProvider;
    // Mistral and OpenAI share the chat-completions shape; only the client and
    // model id differ. Anthropic stays as its own branch — dormant while the
    // build is full-Mistral, one env flip away from active again.
    if (provider === 'mistral' || provider === 'openai') {
      const client =
        provider === 'mistral' ? this.ensureMistral() : this.ensureOpenAi();
      const model =
        provider === 'mistral' ? params.mistralModel : params.openaiModel;
      const response = await client.chat.completions.create({
        model,
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

    const response = await this.ensureAnthropic().messages.create({
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
   * One turn of a tool-use conversation.
   *
   * `complete()` takes `{system, user}` and hands back `{text, usage}` — a shape
   * that cannot express tools, `tool_use` blocks, `tool_result` blocks, or
   * `stop_reason`. The agent loop needs the real message surface, so this method
   * speaks Anthropic's content-block shape end to end: `messages` and `tools`
   * come in Anthropic-shaped, and `content`/`stopReason` go out Anthropic-shaped.
   *
   * When the agent provider is Mistral, that Anthropic shape is a *stable
   * intermediate representation*: `converseMistral` translates it to Mistral's
   * OpenAI-dialect request and translates the reply back, so the entire loop in
   * `base.agent.ts` — cache markers, `tool_result` blocks, forced `tool_choice`
   * — stays provider-agnostic and unchanged.
   */
  async converse(params: LlmConverseParams): Promise<LlmConverseResult> {
    const provider = params.provider ?? this.agentProvider;

    // Mistral and OpenAI share the chat-completions + tool-calling dialect (the
    // Mistral client IS the OpenAI SDK), so both go through one translator —
    // only the client and model id differ. Anthropic keeps its own branch below.
    if (provider === 'mistral') {
      return this.converseOpenAiDialect(this.ensureMistral(), params);
    }
    if (provider === 'openai') {
      return this.converseOpenAiDialect(this.ensureOpenAi(), params);
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
      // Omit entirely when empty — a forced final-answer turn passes no tools,
      // and some providers reject an empty `tools` array.
      ...(params.tools.length ? { tools: params.tools } : {}),
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

    const response = await this.ensureAnthropic().messages.create(
      body as unknown as Anthropic.MessageCreateParamsNonStreaming,
    );

    return {
      stopReason: response.stop_reason,
      content: response.content,
      usage: readUsage(response.usage),
    };
  }

  /**
   * The OpenAI-dialect implementation of `converse`, shared by Mistral and
   * OpenAI — both are driven by the `openai` SDK, so only the client and model
   * id differ. This is what makes the agent provider a one-line switch.
   *
   * Neither has adaptive thinking, `effort`, or prompt-cache markers — so
   * `params.thinking`, `params.effort`, and the `cache_control` blocks the loop
   * stamps on messages are simply dropped in translation. They cost nothing to
   * ignore: caching is a price optimisation, thinking is a depth knob, and
   * neither changes the loop's contract.
   *
   * `strict` on the emit tool is Anthropic-only and is *not* forwarded — the
   * loop already re-validates the emitted payload and grants one repair turn, so
   * a missing field degrades to a cheap correction rather than a hard failure.
   */
  private async converseOpenAiDialect(
    client: OpenAI,
    params: LlmConverseParams,
  ): Promise<LlmConverseResult> {
    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
      {
        model: params.model,
        max_tokens: params.maxTokens,
        messages: toMistralMessages(params.system, params.messages),
        // Omit when empty — OpenAI/Mistral reject an empty `tools` array, and
        // the forced final-answer turn deliberately passes none.
        ...(params.tools.length
          ? { tools: params.tools.map(toMistralTool) }
          : {}),
        ...(params.toolChoice
          ? { tool_choice: toMistralToolChoice(params.toolChoice) }
          : {}),
        // The loop sets disable_parallel_tool_use only on the forced final
        // emit; mirror it so Mistral can't answer that turn with two tool calls.
        ...(params.toolChoice &&
        'disable_parallel_tool_use' in params.toolChoice
          ? { parallel_tool_calls: false }
          : {}),
      };

    const response = await client.chat.completions.create(body);
    const choice = response.choices[0];
    const message = choice?.message;

    // Rebuild Anthropic-shaped content blocks: a text block if the model spoke,
    // then one tool_use block per tool call. base.agent keys on block.type, not
    // stop_reason, so this is the surface that actually matters.
    const content: Anthropic.ContentBlock[] = [];
    if (message?.content && typeof message.content === 'string') {
      content.push({
        type: 'text',
        text: message.content,
        citations: null,
      } as unknown as Anthropic.ContentBlock);
    }
    for (const call of message?.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: parseToolArgs(call.function.arguments),
      } as unknown as Anthropic.ContentBlock);
    }

    return {
      stopReason: mapMistralFinishReason(choice?.finish_reason),
      content,
      usage: {
        input: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
        cacheCreation: 0,
        cacheRead: 0,
      },
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

// ── Anthropic ⇄ Mistral (OpenAI dialect) translation ────────────────────────
//
// The agent loop's conversation state is Anthropic content blocks. These
// functions map that state onto Mistral's OpenAI-shaped request and map the
// reply back. The mapping is total for the shapes this loop actually produces:
// user messages are either a plain string or a list of tool_result blocks;
// assistant messages are text and/or tool_use blocks.

type MistralMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Flatten `{system, Anthropic messages}` into an OpenAI message array.
 *
 * The one ordering rule that matters: an assistant message carrying tool_calls
 * must be followed by a `tool` message per call id before the next assistant
 * turn. The loop always answers a batch of tool_use blocks with a single user
 * message of matching tool_result blocks, so expanding each tool_result to its
 * own `tool` message — in order, right after the assistant — preserves that.
 */
function toMistralMessages(
  system: string,
  messages: Anthropic.MessageParam[],
): MistralMessage[] {
  const out: MistralMessage[] = [{ role: 'system', content: system }];

  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content });
        continue;
      }
      // tool_result blocks become `tool` messages; any stray text becomes a
      // trailing user message. In this loop a user block-array is all
      // tool_result, so the text branch is a defensive fallback.
      const textParts: string[] = [];
      for (const block of m.content) {
        if (block.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolResultText(block),
          });
        } else if (block.type === 'text') {
          textParts.push(block.text);
        }
      }
      if (textParts.length) {
        out.push({ role: 'user', content: textParts.join('\n') });
      }
      continue;
    }

    // assistant
    const blocks: Anthropic.ContentBlockParam[] =
      typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content;
    const textParts: string[] = [];
    const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] =
      [];
    for (const block of blocks) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
      // thinking / redacted_thinking / cache_control-only blocks: nothing to
      // carry across — Mistral has no equivalent.
    }
    const assistant: MistralMessage = {
      role: 'assistant',
      content: textParts.join('\n'),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    out.push(assistant);
  }

  return out;
}

/**
 * A tool_result's content is a string or an array of text blocks in this loop.
 * `is_error` has no Mistral field, so mark it inline — the model reads it the
 * same way it reads an errored Anthropic tool_result.
 */
function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  const raw =
    typeof block.content === 'string'
      ? block.content
      : (block.content ?? [])
          .map((c) => (c.type === 'text' ? c.text : ''))
          .join('\n');
  return block.is_error ? `ERROR: ${raw}` : raw;
}

/** Anthropic tool → OpenAI/Mistral function tool. `strict` is intentionally dropped. */
function toMistralTool(
  tool: Anthropic.ToolUnion,
): OpenAI.Chat.Completions.ChatCompletionTool {
  const t = tool as Anthropic.Tool;
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  };
}

/**
 * The loop only ever forces one specific tool (the emit tool on the final
 * turn). Map that to Mistral's specific-function form; anything else falls back
 * to `auto`.
 */
function toMistralToolChoice(
  choice: Anthropic.ToolChoice,
): OpenAI.Chat.Completions.ChatCompletionToolChoiceOption {
  if (choice.type === 'tool') {
    return { type: 'function', function: { name: choice.name } };
  }
  if (choice.type === 'any') return 'required';
  return 'auto';
}

/** Parse a tool call's JSON arguments; a malformed payload becomes `{}` so the
 * loop's emit-validation + repair turn can recover rather than the run throwing. */
function parseToolArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {};
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** base.agent keys on tool_use blocks, not stop_reason, so this is cosmetic —
 * kept faithful anyway. */
function mapMistralFinishReason(
  reason: string | null | undefined,
): Anthropic.Message['stop_reason'] {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}
