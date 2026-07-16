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
  };

const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** The model the agents actually run, for pricing and for display. */
export const agentModel = (): string =>
  process.env.ANTHROPIC_AGENT_MODEL ?? DEFAULT_MODEL;

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
