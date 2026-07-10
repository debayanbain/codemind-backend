import { ChartSvgBuilder } from './chart-svg.builder';
import { QualityIssue } from '@app/common';

const issue = (category: QualityIssue['category']): QualityIssue => ({
  category,
  location: 'a.ts',
  description: 'x',
});

describe('ChartSvgBuilder', () => {
  const builder = new ChartSvgBuilder();

  describe('qualityDonut', () => {
    it('emits percentages that sum to exactly 100', () => {
      // Three equal thirds: naive rounding yields 33+33+33 = 99.
      const { svg } = builder.qualityDonut({
        issues: [issue('error_handling'), issue('type_safety'), issue('tests')],
      });

      const percents = [...svg.matchAll(/· (\d+)%/g)].map((m) => Number(m[1]));
      expect(percents).toHaveLength(3);
      expect(percents.reduce((a, b) => a + b, 0)).toBe(100);
    });

    it('labels every slice with its own count, so colour is never load-bearing', () => {
      const { svg } = builder.qualityDonut({
        issues: [issue('complexity'), issue('complexity'), issue('tests')],
      });

      expect(svg).toContain('Complexity');
      expect(svg).toContain('2 · 67%');
      expect(svg).toContain('Tests');
      expect(svg).toContain('1 · 33%');
    });

    it('renders a full ring for a single category rather than a degenerate wedge', () => {
      const { svg } = builder.qualityDonut({ issues: [issue('tests')] });

      // One arc, dash length == full circumference, remainder 0.
      const dash = /stroke-dasharray="([\d.]+) ([\d.]+)"/.exec(svg);
      expect(dash).not.toBeNull();
      expect(Number(dash![2])).toBeCloseTo(0, 1);
    });

    it('has an empty state instead of a blank chart', () => {
      const { svg, source } = builder.qualityDonut({ issues: [] });

      expect(svg).toContain('No quality issues found');
      expect((JSON.parse(source) as { segments: unknown[] }).segments).toEqual(
        [],
      );
    });

    it('escapes markup coming from agent output', () => {
      const { svg } = builder.qualityDonut({
        issues: [{ ...issue('tests') }],
      });
      expect(svg).not.toMatch(/<script/i);
    });

    it('exposes the finding to screen readers, not just the pixels', () => {
      const { svg } = builder.qualityDonut({ issues: [issue('tests')] });

      expect(svg).toContain('role="img"');
      expect(svg).toMatch(/<desc[^>]*>1 quality issue: Tests 1 \(100%\)/);
    });
  });

  describe('healthGauge', () => {
    it('states the band as text as well as colour', () => {
      expect(builder.healthGauge(90).svg).toContain('HEALTHY');
      expect(builder.healthGauge(70).svg).toContain('NEEDS ATTENTION');
      expect(builder.healthGauge(30).svg).toContain('CRITICAL');
    });

    it('clamps out-of-range and non-finite scores', () => {
      expect(builder.healthGauge(140).svg).toContain('>100<');
      expect(builder.healthGauge(-20).svg).toContain('>0<');
      expect(builder.healthGauge(Number.NaN).svg).toContain('>0<');
    });

    it('draws no arc at all for a zero score', () => {
      const { svg } = builder.healthGauge(0);
      // A zero-length arc must collapse to a moveto; an `A` command with
      // identical start and end points would sweep a whole circle.
      const valueArc = svg
        .split('\n')
        .find((l) => l.includes('stroke="#A63603"'));
      expect(valueArc).toBeDefined();
      expect(valueArc).not.toContain(' A ');
    });

    it('records the score in its source so the chart is re-renderable', () => {
      expect(JSON.parse(builder.healthGauge(73).source)).toMatchObject({
        type: 'gauge',
        score: 73,
        band: 'Needs Attention',
      });
    });
  });
});
