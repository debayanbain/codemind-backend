import { Injectable } from '@nestjs/common';
import { QualityOutput } from '@app/common';
import { CATEGORY_COLORS, healthBand } from './palette';

/**
 * D2 is a diagram language, not a charting library — it has no pie, no donut,
 * no gauge. Rather than fake those with abused box shapes, the two purely
 * quantitative visuals are emitted as hand-built SVG.
 *
 * That keeps the same guarantees as the D2 path: rendered server-side once,
 * inert markup, no client-side charting library, prints to PDF unchanged.
 *
 * Accessibility rules applied throughout:
 *  - every value is directly labelled, so colour is decorative, never load-bearing
 *  - `role="img"` + `<title>`/`<desc>` give screen readers the chart's actual finding
 *  - no animation, so `prefers-reduced-motion` is satisfied by construction
 *  - CSS is scoped to a per-diagram root class, so inlining several in one page is safe
 */
@Injectable()
export class ChartSvgBuilder {
  /** The five buckets the quality agent's `issues[].category` maps onto. */
  private static readonly CATEGORY_LABELS: Record<string, string> = {
    error_handling: 'Error Handling',
    type_safety: 'Type Safety',
    tests: 'Tests',
    complexity: 'Complexity',
    duplication: 'Duplication',
  };

  // ─── Quality donut ─────────────────────────────────────────────────────────

  qualityDonut(qual: QualityOutput): { source: string; svg: string } {
    const issues = qual.issues ?? [];

    const counts = new Map<string, number>();
    for (const issue of issues) {
      const label =
        ChartSvgBuilder.CATEGORY_LABELS[issue.category] ?? 'Error Handling';
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    const segments = [...counts.entries()]
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({
        label,
        value: count,
        color: CATEGORY_COLORS[label] ?? '#767676',
      }));

    const source = JSON.stringify(
      { type: 'donut', title: 'Technical Debt by Category', segments },
      null,
      2,
    );

    if (segments.length === 0) {
      return { source, svg: this.emptyDonut() };
    }

    const total = segments.reduce((sum, s) => sum + s.value, 0);
    const percents = largestRemainder(segments.map((s) => s.value));

    const cls = 'cm-quality-donut';
    const cx = 124;
    const cy = 128;
    const radius = 76;
    const thickness = 34;
    const circumference = 2 * Math.PI * radius;

    // Segments are stroked arcs on one circle rather than wedge paths: a single
    // 100% category then renders as a complete ring for free, where a wedge path
    // would degenerate (start point == end point makes the arc ambiguous).
    let offset = 0;
    const arcs = segments
      .map((s) => {
        const length = (s.value / total) * circumference;
        const arc =
          `<circle class="${cls}-arc" cx="${cx}" cy="${cy}" r="${radius}" ` +
          `fill="none" stroke="${s.color}" stroke-width="${thickness}" ` +
          `stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" ` +
          `stroke-dashoffset="${(-offset).toFixed(2)}" />`;
        offset += length;
        return arc;
      })
      .join('\n    ');

    const legend = segments
      .map((s, i) => {
        const y = 44 + i * 30;
        return (
          `<rect x="264" y="${y - 11}" width="14" height="14" rx="3" fill="${s.color}" />` +
          `<text class="${cls}-legend" x="288" y="${y}">${esc(s.label)}</text>` +
          `<text class="${cls}-value" x="470" y="${y}" text-anchor="end">${s.value} · ${percents[i]}%</text>`
        );
      })
      .join('\n    ');

    const desc =
      `${total} quality ${total === 1 ? 'issue' : 'issues'}: ` +
      segments
        .map((s, i) => `${s.label} ${s.value} (${percents[i]}%)`)
        .join(', ');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 490 256" width="490" height="256" role="img" aria-labelledby="${cls}-t ${cls}-d" class="${cls}">
    <title id="${cls}-t">Technical debt by category</title>
    <desc id="${cls}-d">${esc(desc)}</desc>
    ${this.style(cls)}
    <g transform="rotate(-90 ${cx} ${cy})">
    ${arcs}
    </g>
    <text class="${cls}-total" x="${cx}" y="${cy + 2}" text-anchor="middle">${total}</text>
    <text class="${cls}-caption" x="${cx}" y="${cy + 26}" text-anchor="middle">${total === 1 ? 'issue' : 'issues'}</text>
    ${legend}
  </svg>`;

    return { source, svg };
  }

  // ─── Health gauge ──────────────────────────────────────────────────────────

  healthGauge(rawScore: number): { source: string; svg: string } {
    const score = clamp(Math.round(rawScore), 0, 100);
    const band = healthBand(score);

    const source = JSON.stringify(
      { type: 'gauge', title: 'Overall Health Score', score, band: band.label },
      null,
      2,
    );

    const cls = 'cm-health-gauge';
    const cx = 190;
    const cy = 168;
    const radius = 120;
    const thickness = 24;

    const track = arcPath(cx, cy, radius, 180, 360);
    const value = arcPath(cx, cy, radius, 180, 180 + (score / 100) * 180);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 208" width="380" height="208" role="img" aria-labelledby="${cls}-t ${cls}-d" class="${cls}">
    <title id="${cls}-t">Overall health score</title>
    <desc id="${cls}-d">${score} out of 100 — ${esc(band.label)}</desc>
    ${this.style(cls)}
    <path class="${cls}-track" d="${track}" fill="none" stroke-width="${thickness}" stroke-linecap="round" />
    <path d="${value}" fill="none" stroke="${band.color}" stroke-width="${thickness}" stroke-linecap="round" />
    <text class="${cls}-score" x="${cx}" y="${cy - 18}" text-anchor="middle">${score}</text>
    <text class="${cls}-caption" x="${cx}" y="${cy + 6}" text-anchor="middle">out of 100</text>
    <text class="${cls}-band" x="${cx}" y="${cy + 32}" text-anchor="middle" fill="${band.color}">${esc(band.label.toUpperCase())}</text>
    <text class="${cls}-tick" x="${cx - radius}" y="${cy + 24}" text-anchor="middle">0</text>
    <text class="${cls}-tick" x="${cx + radius}" y="${cy + 24}" text-anchor="middle">100</text>
  </svg>`;

    return { source, svg };
  }

  // ─── Shared ────────────────────────────────────────────────────────────────

  private emptyDonut(): string {
    const cls = 'cm-quality-donut';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 490 256" width="490" height="256" role="img" aria-labelledby="${cls}-t" class="${cls}">
    <title id="${cls}-t">Technical debt by category</title>
    <desc>No quality issues were reported by the analysis.</desc>
    ${this.style(cls)}
    <circle cx="124" cy="128" r="76" fill="none" stroke="#006D5B" stroke-width="34" />
    <text class="${cls}-total" x="124" y="130" text-anchor="middle">0</text>
    <text class="${cls}-caption" x="124" y="154" text-anchor="middle">issues</text>
    <text class="${cls}-legend" x="264" y="134">No quality issues found</text>
  </svg>`;
  }

  /**
   * Scoped to the diagram's own root class: an inlined `<style>` is
   * document-global, and the PDF page carries six SVGs at once.
   *
   * Dark mode is handled the same way D2 handles it — a `prefers-color-scheme`
   * block inside the SVG — so a single stored string serves the light frontend,
   * the dark frontend, and the (always-light) PDF with no re-render.
   */
  private style(cls: string): string {
    return `<style>
      .${cls} text { font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .${cls}-total { font-size: 38px; font-weight: 700; fill: #1A1A1A; }
      .${cls}-score { font-size: 54px; font-weight: 700; fill: #1A1A1A; }
      .${cls}-band { font-size: 13px; font-weight: 700; letter-spacing: 0.08em; }
      .${cls}-caption { font-size: 13px; fill: #5A5A5A; }
      .${cls}-tick { font-size: 12px; fill: #5A5A5A; }
      .${cls}-legend { font-size: 14px; fill: #1A1A1A; }
      .${cls}-value { font-size: 14px; font-weight: 600; fill: #5A5A5A; font-variant-numeric: tabular-nums; }
      .${cls}-track { stroke: #E3E3E3; }
      .${cls}-arc { stroke-linecap: butt; }
      @media (prefers-color-scheme: dark) {
        .${cls}-total, .${cls}-score, .${cls}-legend { fill: #ECECEC; }
        .${cls}-caption, .${cls}-tick, .${cls}-value { fill: #A6A6A6; }
        .${cls}-track { stroke: #3A3A3A; }
      }
    </style>`;
  }
}

// ─── Geometry / formatting helpers ───────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function polar(
  cx: number,
  cy: number,
  r: number,
  degrees: number,
): [number, number] {
  const rad = (degrees * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** SVG arc from `startDeg` to `endDeg`, clockwise, 0° = 3 o'clock. */
function arcPath(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
): string {
  // A zero-length arc has no valid `A` command — collapse it to a bare moveto
  // so a score of 0 renders as nothing rather than as a full circle.
  if (Math.abs(endDeg - startDeg) < 0.01) {
    const [x, y] = polar(cx, cy, r, startDeg);
    return `M ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  const [sx, sy] = polar(cx, cy, r, startDeg);
  const [ex, ey] = polar(cx, cy, r, endDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
}

/**
 * Percentages that actually sum to 100. Naive per-slice rounding gives
 * "33% / 33% / 33%" for thirds, which a reader will (correctly) call a bug.
 */
function largestRemainder(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return values.map(() => 0);

  const exact = values.map((v) => (v / total) * 100);
  const floored = exact.map(Math.floor);
  let remaining = 100 - floored.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);

  for (const { i } of order) {
    if (remaining <= 0) break;
    floored[i] += 1;
    remaining -= 1;
  }
  return floored;
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
