import { sanitizeSvg } from './svg-sanitize';

describe('sanitizeSvg', () => {
  it('removes script blocks and their contents', () => {
    const out = sanitizeSvg(
      '<svg><script>alert(1)</script><text>ok</text></svg>',
    );

    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<text>ok</text>');
  });

  it('removes an unclosed script tag', () => {
    expect(sanitizeSvg('<svg><script src="x.js"></svg>')).not.toContain(
      'script',
    );
  });

  it('strips inline event handlers', () => {
    const out = sanitizeSvg(
      `<svg><rect onclick="steal()" onmouseover='x' fill="red"/></svg>`,
    );

    expect(out).not.toContain('onclick');
    expect(out).not.toContain('onmouseover');
    expect(out).toContain('fill="red"');
  });

  it('strips javascript: urls', () => {
    const out = sanitizeSvg(
      '<svg><a xlink:href="javascript:alert(1)">x</a></svg>',
    );
    expect(out).not.toContain('javascript:');
  });

  it('drops foreignObject, which can smuggle arbitrary HTML', () => {
    const out = sanitizeSvg(
      '<svg><foreignObject><body><img src=x onerror=y></body></foreignObject></svg>',
    );
    expect(out).not.toContain('foreignObject');
    expect(out).not.toContain('onerror');
  });

  it('leaves a normal D2 svg untouched', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:#fff}</style><text>API</text></svg>';
    expect(sanitizeSvg(svg)).toBe(svg);
  });

  it('strips every on*= attribute, including ones it does not recognise', () => {
    // Deliberately over-broad. SVG defines no non-handler attribute beginning
    // with "on", so there is nothing legitimate to lose — whereas an allowlist
    // of known handlers silently misses whatever the platform adds next.
    expect(sanitizeSvg('<svg><text once="1">only</text></svg>')).toBe(
      '<svg><text>only</text></svg>',
    );
  });
});
