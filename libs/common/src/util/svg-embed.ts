/**
 * Makes an SVG safe to embed as raw HTML inside a Markdown document.
 *
 * Two things about D2's output break that, both silently:
 *
 * 1. **Blank lines.** D2's `<style>` block contains them. Markdown's raw-HTML
 *    block ends at the first blank line, so a `<figure>` wrapping a D2 SVG gets
 *    cut in half: everything past the blank line is re-parsed as Markdown and
 *    HTML-escaped into `&lt;rect …&gt;`. Because the cut lands inside `<style>`,
 *    the browser then swallows the rest of the document as CSS text and the page
 *    renders blank. Collapsing blank lines is enough — nothing else terminates
 *    the block.
 *
 * 2. **CDATA.** D2 wraps its CSS in `<![CDATA[ … ]]>`, which is an XML
 *    construct. HTML parses `<style>` content as raw text, so the delimiters
 *    survive as literal CSS tokens and corrupt the first rule. Stripping them is
 *    correct for HTML embedding and harmless for a standalone SVG, where CDATA
 *    is optional anyway.
 *
 * Applied once, at render time, so what lands in the database is already
 * embed-ready for both the PDF exporter and the frontend.
 */
export function normalizeSvgForHtml(svg: string): string {
  return svg
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n')
    .trim();
}
