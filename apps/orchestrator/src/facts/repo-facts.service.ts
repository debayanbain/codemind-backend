import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import CodeGraph from '@colbymchenry/codegraph';
import type {
  ComplexityHotspot,
  DeadCodeFact,
  ModuleEdgeFact,
  ModuleFact,
  RepoFacts,
  RouteFact,
} from '@app/common';

/** Caps. These bound work, and every one of them is reported, never silent. */
const MAX_ROUTES = 60;
const MAX_MODULES = 15;
const MAX_EXPORTS_PER_MODULE = 12;
const MAX_SAMPLE_FILES = 8;
const MAX_HOTSPOTS = 10;
const MAX_DEAD_CODE = 15;
const MAX_CYCLES = 10;
const MAX_MODULE_EDGES = 24;
/** Symbols scanned for complexity before we stop. Bounds a sync graph walk. */
const MAX_METRIC_SCAN = 2000;
/** Yield to the event loop every N sync graph calls — see the note on `breathe`. */
const YIELD_EVERY = 200;

const ROOT_MODULE = '(root)';

/**
 * Derives everything about a repo that the AST already knows. Zero LLM calls.
 *
 * Runs in the orchestrator, once per run, right after `indexAll()` while the
 * graph is hot. Deliberately *not* in the agent-worker: `findCircularDependencies`
 * and `findDeadCode` are full-graph traversals, and doing them per-agent would be
 * five times the work and five times the event-loop stall.
 */
@Injectable()
export class RepoFactsService {
  private readonly logger = new Logger(RepoFactsService.name);

  async build(
    cg: CodeGraph,
    repoPath: string,
    runKey: string,
  ): Promise<RepoFacts> {
    const t = Date.now();
    const degraded: string[] = [];

    const files = cg.getFiles();
    const stats = cg.getStats();

    const loc = await this.countLines(
      repoPath,
      files.map((f) => f.path),
    );

    const languages = Object.entries(stats.filesByLanguage)
      .filter(([, n]) => n > 0)
      .map(([language, n]) => ({ language, files: n }))
      .sort((a, b) => b.files - a.files);

    const facts: RepoFacts = {
      runKey,
      stats: {
        files: stats.fileCount,
        nodes: stats.nodeCount,
        edges: stats.edgeCount,
        linesOfCode: loc.total,
        sizeBytes: files.reduce((s, f) => s + (f.size ?? 0), 0),
      },
      languages,
      dominantLanguage: languages[0]?.language ?? null,
      frameworks: this.safely(
        () => cg.getDetectedFrameworks(),
        [],
        'frameworks',
        degraded,
      ),
      ...this.routeFacts(cg, degraded),
      modules: [],
      moduleDependencies: [],
      complexityHotspots: [],
      circularDependencies: [],
      deadCode: [],
      degraded,
    };

    const fileToModule = new Map(
      files.map((f) => [f.path, moduleOf(f.path)] as const),
    );

    facts.modules = await this.moduleFacts(cg, files, fileToModule, loc.byFile);
    facts.moduleDependencies = await this.moduleEdges(cg, files, fileToModule);
    facts.complexityHotspots = await this.hotspots(cg, files, degraded);
    facts.circularDependencies = this.safely(
      () => cg.findCircularDependencies().slice(0, MAX_CYCLES),
      [],
      'circularDependencies',
      degraded,
    );
    facts.deadCode = this.safely(
      () =>
        cg
          .findDeadCode(['function', 'method', 'class'])
          .slice(0, MAX_DEAD_CODE)
          .map((n) => ({
            symbol: n.name,
            file: n.filePath,
            line: n.startLine,
            kind: n.kind,
          })) as DeadCodeFact[],
      [],
      'deadCode',
      degraded,
    );

    this.logger.log(
      `RepoFacts built in ${Date.now() - t}ms [run=${runKey}] ` +
        `files=${facts.stats.files} nodes=${facts.stats.nodes} ` +
        `edges=${facts.stats.edges} loc=${facts.stats.linesOfCode} ` +
        `routes=${facts.totalRoutes} modules=${facts.modules.length} ` +
        `cycles=${facts.circularDependencies.length}` +
        (degraded.length ? ` degraded=[${degraded.join(',')}]` : ''),
    );

    return facts;
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  /**
   * Real endpoints from the graph. These do two jobs: they replace the security
   * agent's guessed `sensitive_endpoints`, and they're the backbone of the
   * report's usability section — you cannot write an honest "here's how to call
   * this API" from invented routes.
   */
  private routeFacts(
    cg: CodeGraph,
    degraded: string[],
  ): { routes: RouteFact[]; totalRoutes: number } {
    const manifest = this.safely(
      () => cg.getRoutingManifest(MAX_ROUTES),
      null,
      'routes',
      degraded,
    );
    if (!manifest) return { routes: [], totalRoutes: 0 };

    if (manifest.totalRoutes > manifest.entries.length) {
      degraded.push(
        `routes: showing ${manifest.entries.length} of ${manifest.totalRoutes}`,
      );
    }

    return {
      routes: manifest.entries.map((e) => ({
        url: e.url,
        handler: e.handler,
        file: e.handlerFile,
        line: e.handlerLine,
        kind: e.handlerKind,
      })),
      totalRoutes: manifest.totalRoutes,
    };
  }

  // ── Modules ───────────────────────────────────────────────────────────────

  private async moduleFacts(
    cg: CodeGraph,
    files: { path: string }[],
    fileToModule: Map<string, string>,
    locByFile: Map<string, number>,
  ): Promise<ModuleFact[]> {
    const grouped = new Map<string, string[]>();
    for (const f of files) {
      const m = fileToModule.get(f.path) ?? ROOT_MODULE;
      const list = grouped.get(m);
      if (list) list.push(f.path);
      else grouped.set(m, [f.path]);
    }

    const out: ModuleFact[] = [];
    let scanned = 0;

    for (const [name, paths] of grouped) {
      const exports = new Set<string>();
      for (const p of paths) {
        if (exports.size >= MAX_EXPORTS_PER_MODULE) break;
        const nodes = cg.getNodesInFile(p);
        for (const n of nodes) {
          if (exports.size >= MAX_EXPORTS_PER_MODULE) break;
          // 'export' is the precise signal; classes/functions/interfaces are the
          // fallback for languages/parsers that don't emit explicit export nodes.
          if (
            n.kind === 'export' ||
            n.kind === 'class' ||
            n.kind === 'interface' ||
            n.kind === 'function'
          ) {
            exports.add(n.name);
          }
        }
        if (++scanned % YIELD_EVERY === 0) await breathe();
      }

      out.push({
        name,
        files: paths.length,
        linesOfCode: paths.reduce((s, p) => s + (locByFile.get(p) ?? 0), 0),
        sampleFiles: paths.slice(0, MAX_SAMPLE_FILES),
        exports: [...exports],
      });
    }

    return out
      .sort((a, b) => b.linesOfCode - a.linesOfCode)
      .slice(0, MAX_MODULES);
  }

  /**
   * The real module graph: every file's imports, aggregated up to the top-level
   * directory and deduplicated. `weight` is how many file-level imports the edge
   * stands for, which is a genuine signal of coupling strength — and something no
   * model could have known.
   */
  private async moduleEdges(
    cg: CodeGraph,
    files: { path: string }[],
    fileToModule: Map<string, string>,
  ): Promise<ModuleEdgeFact[]> {
    // Nested from -> to -> weight rather than a composite string key. A flat
    // map needs a separator that can never occur in a module name, and a module
    // name is a directory name — it can contain very nearly anything.
    const weights = new Map<string, Map<string, number>>();
    let scanned = 0;

    for (const f of files) {
      const from = fileToModule.get(f.path) ?? ROOT_MODULE;
      let deps: string[] = [];
      try {
        deps = cg.getFileDependencies(f.path);
      } catch {
        continue;
      }

      for (const dep of deps) {
        const to = fileToModule.get(dep);
        // Unknown path == an external/node_modules import. Module edges are about
        // this repo's own wiring; third-party deps are the dependency agent's job.
        if (!to || to === from) continue;
        let row = weights.get(from);
        if (!row) {
          row = new Map<string, number>();
          weights.set(from, row);
        }
        row.set(to, (row.get(to) ?? 0) + 1);
      }

      if (++scanned % YIELD_EVERY === 0) await breathe();
    }

    const edges: ModuleEdgeFact[] = [];
    for (const [from, row] of weights) {
      for (const [to, weight] of row) edges.push({ from, to, weight });
    }

    return edges.sort((a, b) => b.weight - a.weight).slice(0, MAX_MODULE_EDGES);
  }

  // ── Complexity ────────────────────────────────────────────────────────────

  /**
   * Measured coupling, replacing the quality agent's "which files *look* deeply
   * nested" guess. Ranked by how connected a symbol is — the things that hurt to
   * change.
   */
  private async hotspots(
    cg: CodeGraph,
    files: { path: string }[],
    degraded: string[],
  ): Promise<ComplexityHotspot[]> {
    const scored: ComplexityHotspot[] = [];
    let scanned = 0;
    let truncated = false;

    for (const f of files) {
      if (scanned >= MAX_METRIC_SCAN) {
        truncated = true;
        break;
      }
      let nodes: {
        id: string;
        kind: string;
        name: string;
        filePath: string;
        startLine: number;
      }[] = [];
      try {
        nodes = cg.getNodesInFile(f.path);
      } catch {
        continue;
      }

      for (const n of nodes) {
        if (n.kind !== 'function' && n.kind !== 'method') continue;
        if (scanned >= MAX_METRIC_SCAN) {
          truncated = true;
          break;
        }
        try {
          const m = cg.getNodeMetrics(n.id);
          scored.push({
            symbol: n.name,
            file: n.filePath,
            line: n.startLine,
            callers: m.callerCount,
            callees: m.callCount,
            depth: m.depth,
          });
        } catch {
          // A symbol whose metrics can't be read is not worth failing over.
        }
        if (++scanned % YIELD_EVERY === 0) await breathe();
      }
    }

    if (truncated) {
      degraded.push(
        `complexityHotspots: scanned first ${MAX_METRIC_SCAN} symbols only`,
      );
    }

    return scored
      .sort(
        (a, b) =>
          b.callers + b.callees + b.depth - (a.callers + a.callees + a.depth),
      )
      .slice(0, MAX_HOTSPOTS);
  }

  // ── Lines of code ─────────────────────────────────────────────────────────

  /**
   * Physical line counts. The graph tracks byte size but not lines, and "6,287
   * lines of TypeScript" is the kind of concrete number that makes a report read
   * as measured rather than asserted. Files are already capped at 5,000 and
   * 200MB upstream, and this is one pass, once per run, with no LLM behind it.
   */
  private async countLines(
    repoPath: string,
    relPaths: string[],
  ): Promise<{ total: number; byFile: Map<string, number> }> {
    const byFile = new Map<string, number>();
    let total = 0;

    // Bounded concurrency: unbounded Promise.all over thousands of files
    // exhausts the fd table on a large repo.
    const queue = [...relPaths];
    const workers = Array.from({ length: 16 }, async () => {
      for (;;) {
        const rel = queue.pop();
        if (!rel) return;
        try {
          const content = await fs.readFile(path.join(repoPath, rel), 'utf-8');
          const lines = content.length === 0 ? 0 : content.split('\n').length;
          byFile.set(rel, lines);
          total += lines;
        } catch {
          // Indexed but unreadable (symlink, race with cleanup) — skip it.
        }
      }
    });
    await Promise.all(workers);

    return { total, byFile };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * A fact that can't be computed is recorded as degraded and the rest of the
   * pre-pass continues. None of this is worth failing a job over — the agents
   * can still run, they just get less ground truth.
   */
  private safely<T>(
    fn: () => T,
    fallback: T,
    label: string,
    degraded: string[],
  ): T {
    try {
      return fn();
    } catch (e: unknown) {
      this.logger.warn(`RepoFacts: ${label} unavailable — ${String(e)}`);
      degraded.push(label);
      return fallback;
    }
  }
}

/** Top-level directory of a repo-relative path; files at the root group together. */
function moduleOf(relPath: string): string {
  const first = relPath.split('/')[0];
  return first && first !== relPath ? first : ROOT_MODULE;
}

/**
 * Hand the event loop back.
 *
 * Every CodeGraph read is synchronous (`node:sqlite`), and amqplib's heartbeats
 * share this event loop. A few thousand uninterrupted sync graph calls can miss
 * two heartbeats, drop the connection, and get the message redelivered — turning
 * a slow pre-pass into a re-run.
 */
const breathe = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
