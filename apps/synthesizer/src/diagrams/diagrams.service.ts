import { Injectable, Logger } from '@nestjs/common';
import {
  AgentOutputsByType,
  RenderedDiagram,
  RepoFacts,
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
    facts?: RepoFacts,
  ): Promise<RenderedDiagram[]> {
    const arch = byType.architecture ?? {};
    const sec = byType.security ?? {};
    const dep = byType.dependency ?? {};
    const qual = byType.quality ?? {};

    const started = Date.now();
    const diagrams: RenderedDiagram[] = [];

    // The module graph is drawn from the AST's real import edges when we have
    // them, and only falls back to the architecture agent's account when we
    // don't.
    //
    // This is what makes "the diagrams can't hallucinate relationships" true
    // rather than aspirational. The claim was always made about the *builder*
    // being plain TypeScript — but a deterministic builder fed invented input
    // draws an invented graph, and `module_dependencies[]` was invented. Now the
    // edges are `getFileDependencies` aggregated to module level: an edge on
    // this diagram is an import that exists.
    const moduleSource = facts?.moduleDependencies.length
      ? this.d2.moduleGraph({
          modules: facts.modules.map((m) => m.name),
          module_dependencies: facts.moduleDependencies.map((e) => ({
            from: e.from,
            to: e.to,
            label: `${e.weight}`,
          })),
        })
      : this.d2.moduleGraph(arch);

    if (!facts?.moduleDependencies.length) {
      this.logger.warn(
        'No measured module edges — falling back to the architecture agent’s account for the module graph',
      );
    }

    diagrams.push(
      await this.d2Diagram(
        'architecture-modules',
        'Module dependency graph',
        moduleSource,
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

    // Reclaim the D2 WASM worker's linear memory now that this report's diagrams
    // are rendered. Left reused across jobs it ratchets up until the container is
    // OOM-killed and the whole service silently dies — see D2Renderer.recycle.
    await this.renderer.recycle();

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
