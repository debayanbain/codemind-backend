import { Injectable, Logger } from '@nestjs/common';
import {
  AgentOutputsByType,
  RenderedDiagram,
  normalizeSvgForHtml,
} from '@app/common';
import { D2SourceBuilder } from './d2-source.builder';
import { ChartSvgBuilder } from './chart-svg.builder';
import { D2Renderer } from './d2-renderer.service';

/** Cap on request-flow sequence diagrams — an agent can report a dozen. */
const MAX_REQUEST_FLOWS = 3;

/**
 * Builds every diagram for one report and renders each to SVG, once.
 *
 * Rendering here (not at export time, not in the browser) is the point of the
 * D2 migration: the report row ends up holding finished, inert SVG, so the PDF
 * exporter and the frontend both just embed a string. Neither needs a diagram
 * library, and the PDF no longer depends on a CDN script executing inside
 * Puppeteer before the page is captured.
 */
@Injectable()
export class DiagramsService {
  private readonly logger = new Logger(DiagramsService.name);

  constructor(
    private readonly d2: D2SourceBuilder,
    private readonly charts: ChartSvgBuilder,
    private readonly renderer: D2Renderer,
  ) {}

  async buildAll(
    byType: AgentOutputsByType,
    overallHealthScore: number,
  ): Promise<RenderedDiagram[]> {
    const arch = byType.architecture ?? {};
    const sec = byType.security ?? {};
    const dep = byType.dependency ?? {};
    const qual = byType.quality ?? {};

    const started = Date.now();
    const diagrams: RenderedDiagram[] = [];

    diagrams.push(
      await this.d2Diagram(
        'architecture-modules',
        'Module dependency graph',
        this.d2.moduleGraph(arch),
        'elk',
      ),
    );

    const flows = (arch.request_flows ?? []).slice(0, MAX_REQUEST_FLOWS);
    for (const [i, flow] of flows.entries()) {
      diagrams.push(
        await this.d2Diagram(
          `request-flow-${i + 1}`,
          flow.name || `Request flow ${i + 1}`,
          this.d2.sequenceDiagram(flow.steps ?? []),
        ),
      );
    }

    diagrams.push(
      await this.d2Diagram(
        'security-auth-flow',
        'Authentication flow and high-severity findings',
        this.d2.securityFlow(sec),
      ),
    );

    diagrams.push(
      await this.d2Diagram(
        'dependency-graph',
        'Runtime dependencies by risk',
        this.d2.dependencyGraph(dep),
      ),
    );

    // Charts go through the same embed normalisation as D2 output. They don't
    // currently emit blank lines or CDATA, but nothing enforces that, and a
    // single stray blank line inside `<style>` silently blanks the whole PDF.
    const donut = this.charts.qualityDonut(qual);
    diagrams.push({
      slug: 'quality-donut',
      title: 'Technical debt by category',
      kind: 'chart',
      source: donut.source,
      svg: normalizeSvgForHtml(donut.svg),
    });

    const gauge = this.charts.healthGauge(overallHealthScore);
    diagrams.push({
      slug: 'health-gauge',
      title: 'Overall health score',
      kind: 'chart',
      source: gauge.source,
      svg: normalizeSvgForHtml(gauge.svg),
    });

    const degraded = diagrams.filter((d) => d.degraded).map((d) => d.slug);
    this.logger.log(
      `Rendered ${diagrams.length} diagrams in ${Date.now() - started}ms` +
        (degraded.length ? ` | degraded: ${degraded.join(', ')}` : ''),
    );

    return diagrams;
  }

  private async d2Diagram(
    slug: string,
    title: string,
    source: string,
    layout: 'dagre' | 'elk' = 'dagre',
  ): Promise<RenderedDiagram> {
    const { svg, degraded } = await this.renderer.render(source, {
      salt: slug,
      layout,
    });
    return { slug, title, kind: 'd2', source, svg, degraded };
  }
}
