/**
 * Okabe-Ito derived palette: distinguishable under all common forms of colour
 * vision deficiency, and dark enough that white/black text on top clears WCAG
 * AA (4.5:1) rather than only the 3:1 large-text bar.
 *
 * Colour is never the *only* carrier of meaning in any diagram — every risk
 * fill is paired with a text prefix ("CRITICAL", "OUTDATED"), so the diagrams
 * survive greyscale printing and colourblind readers alike.
 */

export interface NodeStyle {
  fill: string;
  text: string;
  stroke: string;
}

export const PALETTE: Record<
  'entry' | 'root' | 'critical' | 'warning' | 'ok' | 'muted',
  NodeStyle
> = {
  entry: { fill: '#0072B2', text: '#FFFFFF', stroke: '#00538A' },
  root: { fill: '#0B4F6C', text: '#FFFFFF', stroke: '#073649' },
  critical: { fill: '#A63603', text: '#FFFFFF', stroke: '#7A2802' },
  warning: { fill: '#E69F00', text: '#1A1A1A', stroke: '#B37B00' },
  ok: { fill: '#006D5B', text: '#FFFFFF', stroke: '#00473B' },
  muted: { fill: '#767676', text: '#FFFFFF', stroke: '#5A5A5A' },
};

/** One colour per quality-issue category, in the donut's fixed slice order. */
export const CATEGORY_COLORS: Record<string, string> = {
  'Error Handling': '#D55E00',
  'Type Safety': '#0072B2',
  Tests: '#009E73',
  Complexity: '#E69F00',
  Duplication: '#CC79A7',
};

/** D2's built-in themes. 0 = Neutral Default, 200 = Dark Mauve. */
export const D2_THEME_LIGHT = 0;
export const D2_THEME_DARK = 200;

export function healthBand(score: number): {
  label: string;
  color: string;
} {
  if (score >= 80) return { label: 'Healthy', color: PALETTE.ok.fill };
  if (score >= 60)
    return { label: 'Needs Attention', color: PALETTE.warning.fill };
  return { label: 'Critical', color: PALETTE.critical.fill };
}
