import { Logger } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import {
  LlmClient,
  TokenUsage,
  RepoFacts,
  EpochFencedError,
  noTokens,
  addTokens,
  totalTokens,
  agentModel,
  AGENT_OUTPUT_SCHEMAS,
  AgentSchemaKey,
} from '@app/common';
import { FactSection, renderFacts } from './facts-prompt';
import {
  GRAPH_TOOL_DEFS,
  ToolContext,
  describeToolUses,
  findTool,
} from '../tools/graph-tools';

export interface AgentContext {
  jobId: string;
  repoPath: string;
  graphContext: string; // seed context from CodeGraph.buildContext()
  /** Zero-LLM ground truth from the orchestrator's pre-pass. */
  facts?: RepoFacts;
  /** The graph + checkout the agent's tools read from. Required to run. */
  tools?: ToolContext;
  /** Throws EpochFencedError if this run has been superseded. Checked per turn. */
  checkAlive?: () => Promise<void>;
  /**
   * Called once per turn with what the loop is about to do, so the UI has
   * something to show while an agent works for minutes. Fire-and-forget: a
   * progress event is never worth failing an agent over.
   */
  onActivity?: (a: {
    turn: number;
    maxTurns: number;
    activity: string;
  }) => void;
  /** Per-agent token ceiling — the cap that actually bounds spend. */
  agentTokenBudget?: number;
  fileTree?: string; // flat file list, cheap to pass
  additionalContext?: string; // agent-specific extras (package.json contents etc.)
}

export interface AgentResult {
  agentType: string;
  jobId: string;
  output: Record<string, any>;
  tokensUsed: TokenUsage;
  success: boolean;
  error?: string;
  durationMs: number;
}

// The model string sent to the provider. `agentModel()` follows AGENT_LLM_PROVIDER
// (Mistral for this build, Anthropic otherwise) so the model we call is the same
// one the report prices and displays — no drift between what ran and what's billed.
const AGENT_EFFORT = (process.env.ANTHROPIC_AGENT_EFFORT ?? 'medium') as
  'low' | 'medium' | 'high' | 'max';
/** Seed-message ceiling. The loop grows past this by design; this bounds turn 1. */
const MAX_INPUT_TOKENS = 12_000;
/** Per-agent default ceiling on total tokens processed. */
const DEFAULT_AGENT_TOKEN_BUDGET = 120_000;
/** Held back so the forced final emit can always afford to run. */
const RESERVE_TOKENS = 8_000;

/**
 * The loop contract, shared by every agent.
 *
 * Two things this has to get right. First, *earn the claim*: the whole reason
 * this agent has tools is so it can check things instead of pattern-matching a
 * plausible answer out of a 20-node context window. Second, *don't re-derive the
 * ground truth* — the facts block cost zero tokens and is exact; spending turns
 * re-discovering the module list is spending the budget on the one part that was
 * already free.
 */
// Reject an emit that arrives before this fraction of the turn budget is spent,
// nudging the agent to investigate thoroughly instead of answering shallowly on
// turn 1-2. Bounded by maxTurns so the loop always terminates. Env-tunable; set
// 0 to disable (emit as soon as the model is ready).
const MIN_EVIDENCE_FRACTION = Number(
  process.env.AGENT_MIN_EVIDENCE_FRACTION ?? 0.6,
);

const LOOP_PREAMBLE = (agentType: string, maxTurns: number) =>
  `You are analysing a codebase you have never seen. You have read-only tools over a
pre-built code graph and the checkout itself. Use them.

How to work:
- Start from the Ground Truth block in the user message. It came from AST parsing:
  it is exact, it cost nothing, and it is not up for debate. Build on it. Do not
  spend turns rediscovering what it already tells you.
- Then investigate what it CANNOT tell you: why the code is shaped this way, what
  is actually wrong, what a new engineer would trip over. That is the only part
  worth your budget.
- search_nodes to find symbols, get_code to read them, get_callers/get_callees to
  trace flows, read_file for config and docs the graph does not index.
- Verify before you assert. If you are about to claim a guard protects a route, read
  the guard and check its callers. A claim you have not checked is one you must not
  make.
- Cite file:line for every specific claim. Tool results give you these — use them.
- You have about ${maxTurns} turns. Investigate in parallel where you can: multiple
  tool calls in one turn is normal and cheaper than one at a time.

How to finish:
- Do not emit early. A two-turn answer is a shallow one. Investigate thoroughly —
  read the important files, trace the main flows, verify claims at file:line — and
  use most of your ${maxTurns}-turn budget before you emit.
- Call emit_${agentType} with your findings. Its schema defines the required shape.
- Be concrete and specific. "Error handling is inconsistent" is worthless; "12 of 19
  handlers in orchestrator.consumer.ts swallow errors with a bare catch (see :127)"
  is a finding. Name real symbols, real files, real lines.
- Report what you found, not what a codebase like this usually has. If you could not
  determine something, say so rather than guessing plausibly.`;

export abstract class BaseAgent {
  protected readonly logger = new Logger(this.constructor.name);
  protected readonly client = new LlmClient();

  abstract readonly agentType: AgentSchemaKey;
  /** This agent's domain brief. The loop mechanics come from LOOP_PREAMBLE. */
  abstract readonly rolePrompt: string;
  abstract buildUserMessage(ctx: AgentContext): string;

  /**
   * Loop mechanics + the agent's brief.
   *
   * The old prompts opened with "Respond ONLY with valid JSON. No preamble." and
   * then inlined the whole schema as prose. Both are now actively wrong: the
   * schema lives on the emit tool (one definition, shared with the validator),
   * and an instruction to answer immediately is the exact opposite of what a
   * tool loop needs.
   */
  get systemPrompt(): string {
    return `${LOOP_PREAMBLE(this.agentType, this.maxTurns)}\n\n${this.rolePrompt}`;
  }

  /**
   * Max output tokens for this agent's LLM call. Extraction agents are fine on
   * the default; architecture asks for a fuller structural map and overrides
   * this upward. Kept modest — output tokens count against the job budget.
   */
  protected readonly maxOutputTokens: number = 2500;

  /**
   * Which slices of the AST ground truth this agent is shown. Each agent takes
   * only what it needs — routes are useless to the docs agent, and complexity
   * metrics are noise to the dependency agent.
   */
  protected readonly factSections: readonly FactSection[] = ['overview'];

  /**
   * How many evidence-gathering turns this agent gets before the emit tool is
   * forced. Architecture overrides upward: it walks module by module, so it has
   * genuinely more ground to cover than "is there a README".
   */
  protected readonly maxTurns: number = 8;

  /**
   * A bounded evidence loop.
   *
   * The old shape was: one keyword-bag graph query, one LLM call, done. The
   * agent never saw a line of code it hadn't been handed up front and could not
   * ask a single follow-up. That is why the reports read like a form.
   *
   * Now: seed the model with the AST ground truth, give it read-only tools over
   * the graph and the checkout, and let it gather evidence until it's ready to
   * answer — capped in turns and in tokens. It ends by calling `emit_<type>`,
   * whose schema is the same definition the validator enforces.
   *
   * The loop never *needs* the model to volunteer an answer: on the last
   * affordable turn the emit tool is forced, so "ran out of turns" and "ran out
   * of budget" both produce a real, if narrower, analysis instead of nothing.
   */
  async run(ctx: AgentContext): Promise<AgentResult> {
    const t = Date.now();
    let usage = noTokens();

    if (!ctx.tools) {
      return this.failure(
        ctx,
        t,
        'Agent invoked without a tool context — cannot run the evidence loop.',
        usage,
      );
    }

    const emitTool = this.emitToolDef();
    const tools = [...GRAPH_TOOL_DEFS, emitTool];
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: this.assembleUserMessage(ctx) },
    ];

    // One extra turn, granted only to repair a schema-invalid emit (see the
    // rejection path below). Not part of the investigation budget.
    let repairTurns = 0;
    // Investigation-depth floor — see MIN_EVIDENCE_FRACTION. Capped at
    // maxTurns-1 so the final turn can always force the emit.
    const minEvidenceTurns = Math.min(
      this.maxTurns - 1,
      Math.ceil(this.maxTurns * MIN_EVIDENCE_FRACTION),
    );

    try {
      for (let turn = 1; turn <= this.maxTurns + repairTurns; turn++) {
        // Re-fence every turn. A force-stop mid-loop used to go unnoticed for
        // the remaining minutes, burning tokens on a run whose results are
        // thrown away — and worse, those tokens landed in the *new* run's
        // counter, because force-retry clears it before the zombie's INCRBY.
        await ctx.checkAlive?.();

        const remaining = this.remainingBudget(ctx, usage);
        // Force the answer when this is the last turn we can afford or the last
        // one allowed. Partial-but-grounded beats empty.
        const mustFinish =
          turn === this.maxTurns + repairTurns || remaining <= RESERVE_TOKENS;
        if (mustFinish && turn > 1) {
          this.logger.warn(
            `[${this.agentType}] forcing emit on turn ${turn} ` +
              `(${turn === this.maxTurns + repairTurns ? 'turn cap' : 'budget'} reached)`,
          );
        }

        const res = await this.client.converse({
          model: agentModel(),
          system: this.systemPrompt,
          messages: withRollingCache(messages),
          tools,
          maxTokens: this.maxOutputTokens,
          thinking: true,
          effort: AGENT_EFFORT,
          ...(mustFinish
            ? {
                toolChoice: {
                  type: 'tool' as const,
                  name: emitTool.name,
                  disable_parallel_tool_use: true,
                },
              }
            : {}),
        });

        usage = addTokens(usage, res.usage);

        const toolUses = res.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );

        // The model answered in prose instead of calling emit. Nudge once; the
        // forced-emit turn will close it out regardless.
        if (!toolUses.length) {
          messages.push({ role: 'assistant', content: res.content });
          messages.push({
            role: 'user',
            content: `Call ${emitTool.name} with your findings now.`,
          });
          continue;
        }

        const emit = toolUses.find((b) => b.name === emitTool.name);
        if (emit) {
          // `strict: true` on the emit tool is supposed to make a missing
          // required field impossible, and in isolation it holds. In a real loop
          // — long tool history, forced `tool_choice` on the last turn — it has
          // still been observed emitting only optional fields. Rather than trust
          // it and discard an agent that already spent its whole budget
          // gathering evidence, check the payload here and give the model one
          // cheap turn to correct itself. The rejection goes back as an errored
          // `tool_result`, which is the only shape allowed to follow a
          // `tool_use`, and is the same "a throwing tool is not a failure"
          // semantic the graph tools already rely on.
          const check = AGENT_OUTPUT_SCHEMAS[this.agentType].validate(
            emit.input,
            this.agentType,
          );
          const canRepair =
            !check.ok && repairTurns === 0 && remaining > RESERVE_TOKENS;

          if (canRepair) {
            repairTurns = 1;
            this.logger.warn(
              `[${this.agentType}] emit rejected on turn ${turn}, repairing: ` +
                `${check.errors.join('; ')} (got keys: ` +
                `${Object.keys(emit.input as object).join(', ') || 'none'})`,
            );
            messages.push({ role: 'assistant', content: res.content });
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: emit.id,
                  is_error: true,
                  content:
                    `Rejected — your analysis was not recorded: ${check.errors.join('; ')}. ` +
                    `Call ${emitTool.name} again with EVERY required field present. ` +
                    `Base it on what you already read; do not gather more evidence. ` +
                    `If you genuinely found nothing for a required list, send an empty array.`,
                },
              ],
            });
            continue;
          }

          // Minimum-evidence gate: reject an emit that lands before the depth
          // floor so the agent keeps investigating instead of answering shallowly
          // on turn 1-2. Never blocks a forced (mustFinish) or budget-limited
          // emit, and `turn` is monotonic so this converges to `minEvidenceTurns`
          // and always terminates.
          const tooEarly =
            !mustFinish &&
            turn < minEvidenceTurns &&
            remaining > RESERVE_TOKENS;
          if (tooEarly) {
            this.logger.debug(
              `[${this.agentType}] emit on turn ${turn} below evidence floor ${minEvidenceTurns} — pushing for more`,
            );
            messages.push({ role: 'assistant', content: res.content });
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: emit.id,
                  is_error: true,
                  content:
                    `Not yet — you have used only ${turn} of ~${this.maxTurns} turns. ` +
                    `Keep investigating before you emit: read the important files, ` +
                    `trace the main flows, and verify each claim at file:line. Gather ` +
                    `substantially more evidence, THEN call ${emitTool.name}.`,
                },
              ],
            });
            continue;
          }

          this.logger.log(
            `[${this.agentType}] emitted on turn ${turn} in ${Date.now() - t}ms | ` +
              `total=${totalTokens(usage)} (in=${usage.input} out=${usage.output} ` +
              `cache_read=${usage.cacheRead ?? 0})`,
          );
          return this.finish(ctx, t, emit.input, usage, mustFinish);
        }

        // Tell the UI what's happening before the work, not after — this line
        // is the only thing standing between the user and a minute of silence.
        this.reportActivity(ctx, turn, toolUses);

        // Execute every requested tool and return all results in ONE user
        // message. Splitting them across messages silently teaches the model to
        // stop making parallel calls.
        messages.push({ role: 'assistant', content: res.content });
        messages.push({
          role: 'user',
          content: await this.runTools(toolUses, ctx.tools),
        });
      }

      // Unreachable in practice: the final turn forces emit. If we get here the
      // model refused a forced tool call, which is worth knowing about.
      return this.failure(
        ctx,
        t,
        `Agent completed ${this.maxTurns} turns without emitting a result.`,
        usage,
      );
    } catch (err: unknown) {
      if (err instanceof EpochFencedError) throw err; // not this agent's failure
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${this.agentType}] failed: ${message}`);
      return this.failure(ctx, t, message, usage);
    }
  }

  /**
   * Run the model's tool calls concurrently and pack the results into one user
   * message.
   *
   * A throwing tool is **not** a failure. The model asked for a node that
   * doesn't exist, or a file that isn't there; `is_error: true` tells it so and
   * it adjusts. Killing the run over a bad argument would throw away every turn
   * already paid for. This is the single most important semantic in the loop.
   */
  private async runTools(
    toolUses: Anthropic.ToolUseBlock[],
    toolCtx: ToolContext,
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    return Promise.all(
      toolUses.map(async (use): Promise<Anthropic.ToolResultBlockParam> => {
        const tool = findTool(use.name);
        if (!tool) {
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: `Unknown tool "${use.name}".`,
            is_error: true,
          };
        }
        try {
          const out = await tool.run(
            (use.input ?? {}) as Record<string, unknown>,
            toolCtx,
          );
          this.logger.debug(`[${this.agentType}] ${use.name} ok`);
          return { type: 'tool_result', tool_use_id: use.id, content: out };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.debug(`[${this.agentType}] ${use.name} error: ${msg}`);
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: msg,
            is_error: true,
          };
        } finally {
          // Every graph read is synchronous (node:sqlite) and amqplib's
          // heartbeats share this event loop. Hand it back between tools.
          await breathe();
        }
      }),
    );
  }

  /**
   * Emit one progress line for this turn. Never throws and never awaits — a
   * dropped progress event costs the UI ~3s (it polls underneath); a thrown one
   * would cost the whole agent.
   */
  private reportActivity(
    ctx: AgentContext,
    turn: number,
    toolUses: Anthropic.ToolUseBlock[],
  ): void {
    if (!ctx.onActivity || !ctx.tools) return;
    try {
      ctx.onActivity({
        turn,
        maxTurns: this.maxTurns,
        activity: describeToolUses(toolUses, ctx.tools),
      });
    } catch (e: unknown) {
      this.logger.debug(
        `[${this.agentType}] progress emit failed: ${String(e)}`,
      );
    }
  }

  /** Validate the emitted payload against this agent's schema. */
  private finish(
    ctx: AgentContext,
    startedAt: number,
    payload: unknown,
    usage: TokenUsage,
    truncated: boolean,
  ): AgentResult {
    const validated = AGENT_OUTPUT_SCHEMAS[this.agentType].validate(
      payload,
      this.agentType,
    );
    if (!validated.ok) {
      this.logger.warn(
        `[${this.agentType}] emitted output failed schema validation: ${validated.errors.join('; ')}`,
      );
      return this.failure(
        ctx,
        startedAt,
        `Output failed schema validation: ${validated.errors.join('; ')}`,
        usage,
      );
    }

    const output = validated.value as Record<string, any>;
    // Mark a forced finish so the report can be honest about depth, rather than
    // presenting a budget-capped analysis as a thorough one.
    if (truncated) output.truncated = true;

    return {
      agentType: this.agentType,
      jobId: ctx.jobId,
      output,
      tokensUsed: usage,
      success: true,
      durationMs: Date.now() - startedAt,
    };
  }

  /** The tool the agent calls to answer. Its schema IS the validator's schema. */
  private emitToolDef(): Anthropic.Tool {
    return {
      name: `emit_${this.agentType}`,
      description:
        `Submit your final ${this.agentType} analysis. Call this once you have ` +
        `gathered enough evidence. Ground every claim in something you actually read.`,
      input_schema: AGENT_OUTPUT_SCHEMAS[this.agentType]
        .jsonSchema as Anthropic.Tool.InputSchema,
      // The API enforces the schema, so a required field can't go missing. Without
      // this the architecture agent emitted an payload with no `request_flows`,
      // `design_patterns` or `summary` — six turns of evidence-gathering already
      // paid for, then discarded at the validator. `obj()` already emits
      // `additionalProperties: false` + `required`, which is exactly what strict
      // wants. The schema kit's note that optional fields must first become
      // `nullable` + required does not hold in practice: the API accepts a
      // `required` list that omits them (verified against haiku-4-5 and
      // sonnet-4-6, both of which report `structured_outputs: true` on the Models
      // API — the older claim that Sonnet 4.6 lacks them was wrong).
      //
      // `strict` lives on newer @anthropic-ai/sdk Tool types; assert so this
      // compiles against an older pinned SDK too. Kept in the payload for the
      // Anthropic path; ignored on the Mistral path the agents currently use.
      strict: true,
    } as Anthropic.Tool;
  }

  private remainingBudget(ctx: AgentContext, spent: TokenUsage): number {
    const cap = ctx.agentTokenBudget ?? DEFAULT_AGENT_TOKEN_BUDGET;
    return cap - totalTokens(spent);
  }

  /**
   * Build the user message and hold it under the input budget.
   *
   * The old version measured only `graphContext` against the ceiling. It never
   * counted `fileTree` (up to 200 files), `additionalContext` (a README capped
   * at 8k, or an *uncapped* manifest), or — now — the facts block. So the
   * "hard 12,000-token ceiling" was only ever enforced against one of four
   * inputs, and a large package.json sailed straight past it.
   *
   * Order of sacrifice is deliberate. Ground truth is never trimmed: it is the
   * densest, cheapest, most reliable thing in the prompt. `graphContext` goes
   * first because CodeGraph returns nodes relevance-sorted, so its tail is the
   * least valuable text in the message.
   */
  private assembleUserMessage(ctx: AgentContext): string {
    const facts = ctx.facts ? renderFacts(ctx.facts, this.factSections) : '';
    const budgetChars =
      (MAX_INPUT_TOKENS - this.estimate(this.systemPrompt) - 500) * 4;

    let trimmed = ctx;
    for (const field of [
      'graphContext',
      'additionalContext',
      'fileTree',
    ] as const) {
      const assembled = this.join(facts, trimmed);
      if (assembled.length <= budgetChars) return assembled;

      const current = trimmed[field];
      if (!current) continue;

      // How much this field must give back, floored at zero.
      const excess = assembled.length - budgetChars;
      const keep = Math.max(0, current.length - excess);
      this.logger.warn(
        `[${this.agentType}] over input budget — truncating ${field} ` +
          `${current.length} → ${keep} chars`,
      );
      trimmed = { ...trimmed, [field]: current.slice(0, keep) };
    }

    const finalMsg = this.join(facts, trimmed);
    if (finalMsg.length > budgetChars) {
      // Everything trimmable is gone and we're still over: the facts block plus
      // the prompt scaffolding alone exceed the ceiling. Say so rather than
      // silently sending an over-budget request.
      this.logger.warn(
        `[${this.agentType}] still ${finalMsg.length - budgetChars} chars over ` +
          `budget after trimming every optional input`,
      );
    }
    return finalMsg;
  }

  private join(facts: string, ctx: AgentContext): string {
    const body = this.buildUserMessage(ctx);
    return facts ? `${facts}\n${body}` : body;
  }

  private estimate(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private failure(
    ctx: AgentContext,
    startedAt: number,
    error: string,
    tokensUsed: TokenUsage,
  ): AgentResult {
    return {
      agentType: this.agentType,
      jobId: ctx.jobId,
      output: {},
      // Tokens were spent even though the output was unusable — bill them, or
      // the budget under-counts exactly the runs that waste the most.
      tokensUsed,
      success: false,
      error,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Put one cache breakpoint on the last block of the most recent turn, and strip
 * any older one.
 *
 * Deliberately *not* on the system prompt: system + 8 tool schemas is ~1.6k
 * tokens, under Sonnet 4.6's 2,048-token minimum cacheable prefix, so a marker
 * there would silently never cache — no error, just `cache_creation_input_tokens:
 * 0` forever. The conversation crosses the minimum after a turn or two, so a
 * rolling breakpoint at the tail caches the whole growing prefix instead.
 *
 * Stripping the old marker keeps us under the 4-breakpoint cap; earlier prefixes
 * still read from cache, because a read matches on the prefix, not the marker.
 */
function withRollingCache(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const stripped = messages.map((m) => ({
    ...m,
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) =>
            'cache_control' in b ? { ...b, cache_control: undefined } : b,
          ),
  })) as Anthropic.MessageParam[];

  const last = stripped[stripped.length - 1];
  if (!last) return stripped;

  // A string content can't carry cache_control — promote it to a text block.
  const blocks =
    typeof last.content === 'string'
      ? [{ type: 'text' as const, text: last.content }]
      : [...last.content];

  const tail = blocks[blocks.length - 1];
  if (tail && typeof tail === 'object') {
    blocks[blocks.length - 1] = {
      ...tail,
      cache_control: { type: 'ephemeral' as const },
    } as (typeof blocks)[number];
  }

  stripped[stripped.length - 1] = {
    ...last,
    content: blocks,
  };
  return stripped;
}

/**
 * Hand the event loop back between synchronous graph reads — see RepoFactsService
 * for the full reasoning. Short version: node:sqlite is sync, amqplib heartbeats
 * share this loop, and a missed heartbeat means redelivery of a message we've
 * already spent minutes of tokens on.
 */
const breathe = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
