import { TokenUsage, totalTokens } from '../types/token-usage.types';

/**
 * The one place a dollar figure is computed.
 *
 * There were three copies of this, and all three were wrong in the same way:
 * `(totalTokens / 1e6) * 0.8`, commented "Haiku input pricing". It applied an
 * *input-only* rate to input+output combined, for a model that wasn't the one
 * running. The frontend's copy even said it was "kept identical so the dashboard
 * and the Markdown agree" — which is the tell: two copies that must agree are
 * one copy that hasn't been written yet. Fixing the renderer alone immediately
 * desynced them.
 *
 * So the API serves the number and nobody recomputes it. This is the whole
 * "cost is measurable, not a promise" claim; a figure that disagrees with itself
 * across two screens is worth less than no figure at all.
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> =
  {
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-sonnet-5': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 1, output: 5 },
    'claude-haiku-4-5-20251001': { input: 1, output: 5 },
    'claude-opus-4-8': { input: 5, output: 25 },
    // Mistral runs the agent tool-loop (synthesis stays Anthropic). Rates are
    // Mistral's published $/1M as of this build — approximate, but the point is
    // that a Mistral agent's tokens are priced at Mistral rates, not silently
    // mispriced at the Sonnet fallback below.
    'mistral-large-latest': { input: 2, output: 6 },
    'mistral-large-2411': { input: 2, output: 6 },
    'mistral-medium-latest': { input: 0.4, output: 2 },
    'mistral-small-latest': { input: 0.2, output: 0.6 },
    'codestral-latest': { input: 0.3, output: 0.9 },
  };

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MISTRAL_AGENT_MODEL = 'mistral-large-latest';
const DEFAULT_MISTRAL_SYNTHESIS_MODEL = 'mistral-large-latest';

export type AgentProvider = 'anthropic' | 'mistral';
export type CompletionProvider = 'anthropic' | 'openai' | 'mistral';

/**
 * Which provider runs the agent tool-loop (`LlmClient.converse`).
 *
 * Independent of the synthesis provider — the two paths pick their provider
 * separately. For this build both run on Mistral (Anthropic is dormant, kept so
 * it can be re-enabled). Explicit `AGENT_LLM_PROVIDER` wins; otherwise a Mistral
 * key is the signal.
 */
export const resolveAgentProvider = (): AgentProvider => {
  const pref = process.env.AGENT_LLM_PROVIDER?.toLowerCase();
  if (pref === 'anthropic') return 'anthropic';
  if (pref === 'mistral') return 'mistral';
  return process.env.MISTRAL_API_KEY ? 'mistral' : 'anthropic';
};

/**
 * Which provider runs the single synthesis call (`LlmClient.complete`).
 *
 * `SYNTHESIS_LLM_PROVIDER` wins, falling back to the legacy `LLM_PROVIDER`; with
 * neither set, a Mistral key means Mistral. The full-Mistral build routes
 * synthesis here too so Anthropic makes zero calls — the Anthropic branch stays
 * in `complete()`, dormant, to switch back later.
 */
export const resolveSynthesisProvider = (): CompletionProvider => {
  const pref = (
    process.env.SYNTHESIS_LLM_PROVIDER ?? process.env.LLM_PROVIDER
  )?.toLowerCase();
  if (pref === 'mistral') return 'mistral';
  if (pref === 'openai') return 'openai';
  if (pref === 'anthropic') return 'anthropic';
  return process.env.MISTRAL_API_KEY ? 'mistral' : 'anthropic';
};

/**
 * The model the agents actually run, for pricing and for display. Follows the
 * active agent provider so the cost the report shows is priced against the
 * model that produced the tokens.
 */
export const agentModel = (): string =>
  resolveAgentProvider() === 'mistral'
    ? (process.env.MISTRAL_AGENT_MODEL ?? DEFAULT_MISTRAL_AGENT_MODEL)
    : (process.env.ANTHROPIC_AGENT_MODEL ?? DEFAULT_MODEL);

/** The model the synthesis call runs, following the active synthesis provider. */
export const synthesisModel = (): string => {
  switch (resolveSynthesisProvider()) {
    case 'mistral':
      return (
        process.env.MISTRAL_SYNTHESIS_MODEL ?? DEFAULT_MISTRAL_SYNTHESIS_MODEL
      );
    case 'openai':
      return process.env.OPENAI_SYNTHESIS_MODEL ?? 'gpt-4o';
    default:
      return process.env.ANTHROPIC_SYNTHESIS_MODEL ?? DEFAULT_MODEL;
  }
};

/**
 * Blend assumption: we persist *total tokens processed*, not the input/output
 * split, so assume 85/15. Stating the assumption beats a precise-looking wrong
 * number.
 *
 * Deliberately over-reports rather than under: cache reads bill at ~0.1x input
 * but are priced here at the full rate. For a number you make spend decisions
 * on, erring high is the safe direction.
 */
export function estimateCostUsd(tokens: number, model = agentModel()): number {
  const rate = MODEL_PRICING[model] ?? MODEL_PRICING[DEFAULT_MODEL];
  return (tokens / 1_000_000) * (rate.input * 0.85 + rate.output * 0.15);
}

/** Cost of one recorded usage row. */
export const estimateUsageCostUsd = (u: TokenUsage, model?: string): number =>
  estimateCostUsd(totalTokens(u), model);

/** `$0.576` — formatted once so every surface renders it identically. */
export const formatUsd = (usd: number): string => `$${usd.toFixed(3)}`;
