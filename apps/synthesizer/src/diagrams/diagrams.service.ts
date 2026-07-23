import { Injectable, Logger } from '@nestjs/common';
import {
  AgentOutputsByType,
  RenderedDiagram,
  RepoFacts,
  normalizeSvgForHtml,
} from '@app/common';
import { D2SourceBuilder, countNodes } from './d2-source.builder';
import { ChartSvgBuilder } from './chart-svg.builder';
import { D2Renderer } from './d2-renderer.service';

/** Cap on request-flow sequence diagrams — an agent can report a dozen. */
const MAX_REQUEST_FLOWS = 3;

/**
 * Below this, a diagram is dropped rather than rendered.
 *
 * The reference report shipped a two-box "Authentication Flow" and a two-box
 * "Login Flow". Both were technically valid D2 and both were worse than nothing:
 * a diagram is a claim that a structure was found, and two boxes with one arrow
 * is the absence of one. The report renders the underlying table instead, which
 * says the same thing without pretending to be a picture.
 */
const MIN_DIAGRAM_NODES = 3;

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
    const suppressed: string[] = [];

    /** Render, unless the source is too thin to be worth drawing. */
    const push = async (
      slug: string,
      title: string,
      source: string,
      layout: 'dagre' | 'elk' = 'dagre',
    ): Promise<void> => {
      if (countNodes(source) < MIN_DIAGRAM_NODES) {
        suppressed.push(slug);
        return;
      }
      diagrams.push(await this.d2Diagram(slug, title, source, layout));
    };

    // The end-to-end spine, and the only diagram drawn purely from measured
    // facts end to end: entry → real call hops → the packages that path reaches.
    if (facts) {
      await push(
        'system-flow',
        'End-to-end path through the system',
        this.d2.systemFlow(facts.callChains, facts.externalImports),
        'elk',
      );
    }

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

    await push(
      'architecture-modules',
      'Module dependency graph',
      moduleSource,
      'elk',
    );

    // Sequence diagrams come from measured call chains when we have them, and
    // the agent supplies only the human-readable name. Its `steps[]` used to
    // drive the arrows directly, which is how a diagram came to assert
    // `setAgentStatus -> getJob` — two symbols the model listed in a row, not a
    // call the graph has.
    const chains = facts?.callChains ?? [];
    if (chains.length > 0) {
      const named = arch.request_flows ?? [];
      for (const [i, chain] of chains.slice(0, MAX_REQUEST_FLOWS).entries()) {
        await push(
          `request-flow-${i + 1}`,
          named[i]?.name || `Flow from ${chain.name}`,
          this.d2.sequenceFromChain(chain),
        );
      }
    } else {
      const flows = (arch.request_flows ?? []).slice(0, MAX_REQUEST_FLOWS);
      for (const [i, flow] of flows.entries()) {
        await push(
          `request-flow-${i + 1}`,
          flow.name || `Request flow ${i + 1}`,
          this.d2.sequenceDiagram(flow.steps ?? []),
        );
      }
    }

    await push(
      'security-auth-flow',
      'Authentication flow and high-severity findings',
      this.d2.securityFlow(sec),
    );

    await push(
      'dependency-graph',
      'Module dependencies on third-party packages',
      this.d2.dependencyGraph(dep, facts?.externalImports ?? []),
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
        (degraded.length ? ` | degraded: ${degraded.join(', ')}` : '') +
        (suppressed.length
          ? ` | suppressed (under ${MIN_DIAGRAM_NODES} nodes): ${suppressed.join(', ')}`
          : ''),
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
