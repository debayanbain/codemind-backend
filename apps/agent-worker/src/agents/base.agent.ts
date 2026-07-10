import { Logger } from '@nestjs/common';
import { LlmClient } from '@app/common';

export interface AgentContext {
  jobId: string;
  repoPath: string;
  graphContext: string; // from CodeGraph.buildContext()
  fileTree?: string; // flat file list, cheap to pass
  additionalContext?: string; // agent-specific extras (package.json contents etc.)
}

export interface AgentResult {
  agentType: string;
  jobId: string;
  output: Record<string, any>;
  tokensUsed: { input: number; output: number };
  success: boolean;
  error?: string;
  durationMs: number;
}

// All agents use Haiku — cheap, fast, extraction-style tasks.
// Only the synthesizer uses Sonnet for cross-agent reasoning.
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const OPENAI_AGENT_MODEL = process.env.OPENAI_AGENT_MODEL ?? 'gpt-4o-mini';
const MAX_INPUT_TOKENS = 12_000; // hard ceiling per agent call

export abstract class BaseAgent {
  protected readonly logger = new Logger(this.constructor.name);
  protected readonly client = new LlmClient();

  abstract readonly agentType: string;
  abstract readonly systemPrompt: string;
  abstract buildUserMessage(ctx: AgentContext): string;

  /**
   * Max output tokens for this agent's LLM call. Extraction agents are fine on
   * the default; architecture asks for a fuller structural map and overrides
   * this upward. Kept modest — output tokens count against the job budget.
   */
  protected readonly maxOutputTokens: number = 1500;

  async run(ctx: AgentContext): Promise<AgentResult> {
    const t = Date.now();

    try {
      // Enforce token budget BEFORE calling LLM — not after
      const safeCtx = this.enforceBudget(ctx);
      const userMsg = this.buildUserMessage(safeCtx);

      const response = await this.client.complete({
        anthropicModel: HAIKU_MODEL,
        openaiModel: OPENAI_AGENT_MODEL,
        maxTokens: this.maxOutputTokens,
        system: this.systemPrompt,
        user: userMsg,
      });

      this.logger.log(
        `[${this.agentType}] done in ${Date.now() - t}ms | ` +
          `in=${response.usage.inputTokens} out=${response.usage.outputTokens}`,
      );

      return {
        agentType: this.agentType,
        jobId: ctx.jobId,
        output: this.safeParseJson(response.text),
        tokensUsed: {
          input: response.usage.inputTokens,
          output: response.usage.outputTokens,
        },
        success: true,
        durationMs: Date.now() - t,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${this.agentType}] failed: ${message}`);
      return {
        agentType: this.agentType,
        jobId: ctx.jobId,
        output: {},
        tokensUsed: { input: 0, output: 0 },
        success: false,
        error: message,
        durationMs: Date.now() - t,
      };
    }
  }

  /**
   * Truncate graphContext from the END if over budget.
   * CodeGraph returns nodes sorted by relevance — least relevant last.
   * So truncating from the end preserves the highest-signal nodes.
   */
  private enforceBudget(ctx: AgentContext): AgentContext {
    const sysToks = this.estimate(this.systemPrompt);
    const overhead = 500; // padding for user message wrapper
    const budgetChars = (MAX_INPUT_TOKENS - sysToks - overhead) * 4;

    if (ctx.graphContext.length <= budgetChars) return ctx;

    this.logger.warn(
      `[${this.agentType}] truncating context ${ctx.graphContext.length} → ${budgetChars} chars`,
    );
    return { ...ctx, graphContext: ctx.graphContext.slice(0, budgetChars) };
  }

  private estimate(text: string): number {
    return Math.ceil(text.length / 4);
  }

  protected safeParseJson(raw: string): Record<string, any> {
    const cleaned = raw
      .replace(/^```json\s*/m, '')
      .replace(/^```\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();

    try {
      return JSON.parse(cleaned) as Record<string, any>;
    } catch {
      this.logger.warn(
        `[${this.agentType}] JSON parse failed, returning { raw }`,
      );
      return { raw };
    }
  }
}
