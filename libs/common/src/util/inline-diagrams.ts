import { DIAGRAM_FENCE_RE, RenderedDiagram } from '../types/diagram.types';
import { normalizeSvgForHtml } from './svg-embed';

/**
 * Swaps each diagram fence in a stored report for its pre-rendered SVG.
 *
 * The Markdown keeps the *source* (D2 DSL, or a chart's data JSON), not the
 * SVG — so `?format=md` stays a readable, diffable, portable text document, and
 * a report remains re-renderable if the diagram style ever changes. The SVG
 * lives beside it on the report row and is spliced in only for HTML and PDF.
 *
 * A fence with no matching diagram is left exactly as it was: better a visible
 * code block than a hole where a diagram should be.
 */
export function inlineDiagrams(
  markdown: string,
  diagrams: RenderedDiagram[],
): string {
  const bySlug = new Map(diagrams.map((d) => [d.slug, d]));

  // `DIAGRAM_FENCE_RE` is a module-level /g regex, so `lastIndex` persists
  // across calls. Rebuild it per call rather than reset it — cheaper to reason
  // about than remembering why an export silently skipped its first diagram.
  const re = new RegExp(DIAGRAM_FENCE_RE.source, DIAGRAM_FENCE_RE.flags);

  return markdown.replace(re, (whole, _kind: string, slug: string) => {
    const diagram = bySlug.get(slug);
    if (!diagram) return whole;

    // Re-normalise even though the synthesizer already did. A single blank line
    // anywhere inside this block ends the Markdown raw-HTML block mid-SVG, and
    // the failure mode is a silently blank diagram, not an error. Idempotent, so
    // it costs nothing to be sure at the point where it actually matters.
    return [
      `<figure class="cm-diagram" data-slug="${slug}">`,
      normalizeSvgForHtml(diagram.svg),
      `<figcaption>${escapeHtml(diagram.title)}</figcaption>`,
      `</figure>`,
    ].join('\n');
  });
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
