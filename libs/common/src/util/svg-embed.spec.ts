import { normalizeSvgForHtml } from './svg-embed';

describe('normalizeSvgForHtml', () => {
  it('collapses blank lines, which would otherwise end the markdown html block', () => {
    // This is the exact shape of D2's output: a <style> containing a blank line.
    // Left alone, markdown-it stops the raw-HTML block there, escapes the rest
    // into &lt;rect&gt;, and the browser eats the document as CSS. Blank page.
    const svg =
      '<svg>\n<style>\n.a{fill:red}\n\n.b{fill:blue}\n</style>\n<rect/>\n</svg>';
    const out = normalizeSvgForHtml(svg);

    expect(out).not.toMatch(/\n[ \t]*\n/);
    expect(out).toContain('.a{fill:red}');
    expect(out).toContain('.b{fill:blue}');
    expect(out).toContain('<rect/>');
  });

  it('collapses runs of several blank lines, and indented ones', () => {
    expect(normalizeSvgForHtml('<svg>\na\n\n\n   \n\nb\n</svg>')).toBe(
      '<svg>\na\nb\n</svg>',
    );
  });

  it('strips CDATA delimiters, which are inert in XML but corrupt CSS in HTML', () => {
    const out = normalizeSvgForHtml(
      '<svg><style><![CDATA[.a{fill:red}]]></style></svg>',
    );

    expect(out).toBe('<svg><style>.a{fill:red}</style></svg>');
  });

  it('is idempotent', () => {
    const svg = '<svg>\n<style><![CDATA[\n.a{fill:red}\n\n]]></style>\n</svg>';
    const once = normalizeSvgForHtml(svg);

    expect(normalizeSvgForHtml(once)).toBe(once);
  });

  it('leaves a well-formed single-line svg untouched', () => {
    const svg = '<svg><rect fill="red"/></svg>';
    expect(normalizeSvgForHtml(svg)).toBe(svg);
  });

  it('preserves meaningful newlines between elements', () => {
    expect(normalizeSvgForHtml('<svg>\n<a/>\n<b/>\n</svg>')).toBe(
      '<svg>\n<a/>\n<b/>\n</svg>',
    );
  });
});
