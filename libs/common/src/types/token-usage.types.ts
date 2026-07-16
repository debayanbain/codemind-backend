/**
 * Token accounting for a single LLM call.
 *
 * Four classes, not two. The Anthropic API bills input in three separate
 * buckets and `usage.input_tokens` is only the **uncached remainder** — the
 * rest lands in `cache_creation_input_tokens` and `cache_read_input_tokens`.
 * Summing `input + output` was correct only for as long as prompt caching was
 * off; the moment it's on, an agent that processed 74k tokens reports ~8k, the
 * job budget silently stops binding, and `agent_results.tokensUsed` — the whole
 * "cost is measurable, not a promise" claim — becomes fiction.
 *
 * So `tokensUsed` means **total tokens processed**, cache-independent. The
 * Redis key name (`job:{id}:tokens_used`, CLAUDE.md section 6) is unchanged;
 * only the definition is now honest.
 *
 * The three input classes are kept separate rather than pre-summed because they
 * bill at ~1x / ~1.25x / ~0.1x respectively — a cost estimate needs them apart,
 * and cache_read staying at 0 across a run is the signal that caching silently
 * broke.
 */
export interface TokenUsage {
  /** Uncached input tokens, billed at the full rate. */
  input: number;
  /** Output tokens. */
  output: number;
  /** Tokens written to the cache this call, billed ~1.25x. */
  cacheCreation?: number;
  /** Tokens served from the cache this call, billed ~0.1x. */
  cacheRead?: number;
}

/** Total tokens processed — what the budget counts and what gets persisted. */
export const totalTokens = (u: TokenUsage): number =>
  u.input + u.output + (u.cacheCreation ?? 0) + (u.cacheRead ?? 0);

/** Zero usage — for paths that record a failure without calling the LLM. */
export const noTokens = (): TokenUsage => ({
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
});

/** Accumulate usage across the turns of an agentic loop. */
export const addTokens = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheCreation: (a.cacheCreation ?? 0) + (b.cacheCreation ?? 0),
  cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
});
