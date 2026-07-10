import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export interface LlmCompleteParams {
  system: string;
  user: string;
  anthropicModel: string;
  openaiModel: string;
  maxTokens: number;
}

export interface LlmCompleteResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
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
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
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
      text: response.content[0]?.type === 'text' ? response.content[0].text : '',
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
