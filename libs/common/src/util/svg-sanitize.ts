/**
 * Node labels in every diagram originate in LLM output, which means they are
 * attacker-influenced: a repo can contain a file or symbol named
 * `<script>fetch(...)</script>` and an agent will faithfully report it.
 *
 * Those labels end up as text inside an SVG that we then embed directly into
 * an HTML page (PDF export) and into the DOM (frontend). D2 escapes text into
 * `<text>` nodes, so this is belt-and-braces rather than the only line of
 * defence — but "the diagram renderer escapes properly" is not something worth
 * betting a stored-XSS on.
 *
 * Deliberately a denylist over a fixed, known-shape input (our own D2/chart
 * output), not a general-purpose SVG sanitizer for arbitrary uploads.
 */

const SCRIPT_BLOCK = /<script\b[\s\S]*?<\/script\s*>/gi;
const DANGLING_SCRIPT_OPEN = /<\s*\/?\s*script\b[^>]*>/gi;
const FOREIGN_OBJECT = /<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi;
const EVENT_HANDLER_ATTR = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URI =
  /(?:href|xlink:href|src)\s*=\s*(?:"|')?\s*javascript:[^"'>\s]*/gi;

export function sanitizeSvg(svg: string): string {
  return svg
    .replace(SCRIPT_BLOCK, '')
    .replace(DANGLING_SCRIPT_OPEN, '')
    .replace(FOREIGN_OBJECT, '')
    .replace(EVENT_HANDLER_ATTR, '')
    .replace(JS_URI, '');
}
