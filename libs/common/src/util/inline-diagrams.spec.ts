import { inlineDiagrams } from './inline-diagrams';
import { RenderedDiagram } from '../types/diagram.types';

const diagram = (
  slug: string,
  kind: 'd2' | 'chart' = 'd2',
): RenderedDiagram => ({
  slug,
  title: `Title for ${slug}`,
  kind,
  source: 'a -> b',
  svg: `<svg id="${slug}"></svg>`,
});

describe('inlineDiagrams', () => {
  it('replaces a fence with its rendered svg inside a captioned figure', () => {
    const md = '# R\n\n```d2 arch\na -> b\n```\n\ntail';
    const html = inlineDiagrams(md, [diagram('arch')]);

    expect(html).toContain('<figure class="cm-diagram" data-slug="arch">');
    expect(html).toContain('<svg id="arch"></svg>');
    expect(html).toContain('<figcaption>Title for arch</figcaption>');
    expect(html).not.toContain('```');
    expect(html).toContain('tail');
  });

  it('handles chart fences as well as d2 fences', () => {
    const md = '```chart gauge\n{"score":73}\n```';
    expect(inlineDiagrams(md, [diagram('gauge', 'chart')])).toContain(
      '<svg id="gauge"></svg>',
    );
  });

  it('replaces every fence in a document, not just the first', () => {
    const md = '```d2 a\nx\n```\n\n```d2 b\ny\n```\n\n```d2 c\nz\n```';
    const html = inlineDiagrams(md, [diagram('a'), diagram('b'), diagram('c')]);

    expect(html.match(/<figure/g)).toHaveLength(3);
  });

  it('is stateless across calls', () => {
    // The fence regex is a module-level /g literal; sharing it across calls
    // would carry `lastIndex` over and skip the first fence on call two.
    const md = '```d2 a\nx\n```';
    const first = inlineDiagrams(md, [diagram('a')]);
    const second = inlineDiagrams(md, [diagram('a')]);

    expect(second).toBe(first);
  });

  it('leaves a fence whose diagram is missing exactly as it found it', () => {
    const md = '```d2 ghost\na -> b\n```';
    expect(inlineDiagrams(md, [diagram('other')])).toBe(md);
  });

  it('tolerates a report written before diagrams were persisted', () => {
    const md = '# Report\n\nno diagrams here';
    expect(inlineDiagrams(md, [])).toBe(md);
  });

  it('does not touch ordinary code fences', () => {
    const md = '```ts\nconst d2 = 1;\n```';
    expect(inlineDiagrams(md, [diagram('ts')])).toBe(md);
  });

  it('emits no blank line inside the figure, whatever the svg contains', () => {
    // A blank line here terminates the markdown raw-HTML block mid-SVG and the
    // diagram silently disappears from the PDF. Regression guard.
    const d = {
      ...diagram('x'),
      svg: '<svg>\n<style>\na{}\n\nb{}\n</style>\n</svg>',
    };
    const figure = inlineDiagrams('```d2 x\na\n```', [d]);

    expect(figure).not.toMatch(/\n[ \t]*\n/);
    expect(figure).toContain('a{}');
    expect(figure).toContain('b{}');
  });

  it('escapes markup in a caption', () => {
    const d = { ...diagram('x'), title: '<script>alert(1)</script>' };
    const html = inlineDiagrams('```d2 x\na\n```', [d]);

    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
