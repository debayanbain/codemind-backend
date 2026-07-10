/**
 * Diagrams are built as text (D2 source, or a chart's data JSON) and rendered
 * to SVG once, in the synthesizer, at report-build time. Both the source and
 * the rendered SVG are persisted on the report.
 *
 * Rendering server-side is the whole point of using D2 over Mermaid: Mermaid
 * only renders inside a browser, which forced the PDF exporter to inject a CDN
 * script and hope Puppeteer executed it before capture. A D2 SVG is inert —
 * the PDF path and the frontend both just embed a string.
 */

/** `d2` — source is D2 DSL. `chart` — source is the chart's data as JSON. */
export type DiagramKind = 'd2' | 'chart';

export interface RenderedDiagram {
  /** Stable, URL-safe id. Also the anchor used to splice the SVG back into the Markdown. */
  slug: string;
  /** Human-readable caption, rendered as the <figcaption> in HTML/PDF. */
  title: string;
  kind: DiagramKind;
  /** The text the SVG was rendered from — kept so a report stays re-renderable. */
  source: string;
  svg: string;
  /**
   * True when rendering failed and `svg` is a placeholder. A degraded diagram
   * never fails the job — a report with 5 of 6 diagrams still has value.
   */
  degraded?: boolean;
}

/**
 * Matches a diagram fence in a rendered report, e.g.
 *
 * ```d2 architecture-modules
 * a -> b
 * ```
 *
 * Capture groups: 1 = kind, 2 = slug.
 */
export const DIAGRAM_FENCE_RE =
  /^```(d2|chart)[ \t]+([A-Za-z0-9_-]+)[ \t]*\n[\s\S]*?\n```$/gm;
