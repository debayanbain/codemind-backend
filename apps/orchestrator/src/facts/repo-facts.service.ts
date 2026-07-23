import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import CodeGraph from '@colbymchenry/codegraph';
import type {
  CallChainFact,
  CallStepFact,
  ComplexityHotspot,
  DeadCodeFact,
  DependencyFact,
  EntryPointFact,
  ExternalImportFact,
  LargestFileFact,
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

/** Caps on the newer facts. Same rule: bounded, and the bound is reported. */
const MAX_CALL_CHAINS = 5;
const MAX_CHAIN_STEPS = 8;
/** A chain shorter than this says nothing a table doesn't say better. */
const MIN_CHAIN_STEPS = 3;
/** Seeds tried before giving up on finding MAX_CALL_CHAINS usable chains. */
const MAX_CHAIN_SEEDS = 24;
const MAX_EXTERNAL_IMPORTS = 40;
const MAX_DEPENDENCIES = 80;
const MAX_ENTRY_POINTS = 12;
const MAX_LARGEST_FILES = 8;

/**
 * The facts payload is one Redis string with a 24h TTL, read by five agents and
 * the synthesizer. Log loudly if it grows past this — the caps above exist to
 * keep it well under, and a breach means one of them stopped working.
 */
const FACTS_SIZE_WARN_BYTES = 256 * 1024;

const ROOT_MODULE = '(root)';

/** Scripts worth showing first — "how do I run this" before "how do I lint it". */
const SCRIPT_PRIORITY = [
  'dev',
  'start',
  'start:dev',
  'build',
  'test',
  'migrate',
  'lint',
];

const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[a-z]+$/i;
const DOC_PATH = /\.(md|mdx|rst|adoc)$/i;

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
      callChains: [],
      externalImports: [],
      dependencies: [],
      entryPoints: [],
      testFiles: files.filter((f) => TEST_PATH.test(f.path)).length,
      docFiles: files.filter((f) => DOC_PATH.test(f.path)).length,
      largestFiles: [...loc.byFile.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_LARGEST_FILES)
        .map(([path, linesOfCode]): LargestFileFact => ({ path, linesOfCode })),
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

    // Manifest first: the declared dependency list is what tells `externalImports`
    // which specifiers are real packages rather than path aliases or builtins.
    facts.dependencies = await this.dependencyFacts(repoPath, degraded);
    facts.externalImports = await this.externalImportFacts(
      cg,
      fileToModule,
      facts.dependencies,
      degraded,
    );
    facts.entryPoints = await this.entryPointFacts(cg, repoPath, degraded);
    facts.callChains = await this.callChainFacts(cg, facts.routes, degraded);

    const sizeBytes = JSON.stringify(facts).length;
    if (sizeBytes > FACTS_SIZE_WARN_BYTES) {
      this.logger.warn(
        `RepoFacts payload is ${Math.round(sizeBytes / 1024)}KB [run=${runKey}] — ` +
          `every agent reads this from Redis, so a cap has probably stopped working`,
      );
    }

    this.logger.log(
      `RepoFacts built in ${Date.now() - t}ms [run=${runKey}] ` +
        `files=${facts.stats.files} nodes=${facts.stats.nodes} ` +
        `edges=${facts.stats.edges} loc=${facts.stats.linesOfCode} ` +
        `routes=${facts.totalRoutes} modules=${facts.modules.length} ` +
        `cycles=${facts.circularDependencies.length} ` +
        `chains=${facts.callChains.length} ` +
        `extImports=${facts.externalImports.length} ` +
        `deps=${facts.dependencies.length} ` +
        `entries=${facts.entryPoints.length} ` +
        `size=${Math.round(sizeBytes / 1024)}KB` +
        (degraded.length ? ` degraded=[${degraded.join(',')}]` : ''),
    );

    return facts;
  }

  // ── Call chains ───────────────────────────────────────────────────────────

  /**
   * Walk real `calls` edges from each route handler outward, producing ordered
   * paths through the code.
   *
   * This replaces the architecture agent's `request_flows[].steps`, which was a
   * list of symbol names a model wrote down. Rendered as a sequence diagram that
   * produced edges that are not calls: the reference report drew
   * `setAgentStatus -> getJob`, which is two symbols listed in a row, not an
   * edge the graph has. Every hop here is an edge the graph has.
   *
   * At each hop we prefer a callee in a *different file* — crossing a module
   * boundary is the informative step, while three hops inside one file is
   * mostly noise — and break ties on how much the candidate itself calls, so
   * the walk heads towards the substance rather than into a leaf helper.
   */
  private async callChainFacts(
    cg: CodeGraph,
    routes: RouteFact[],
    degraded: string[],
  ): Promise<CallChainFact[]> {
    const seeds = this.chainSeeds(cg, routes, degraded);
    if (seeds.length === 0) return [];

    const chains: CallChainFact[] = [];
    let scanned = 0;

    for (const seed of seeds.slice(0, MAX_CHAIN_SEEDS)) {
      if (chains.length >= MAX_CALL_CHAINS) break;

      const steps: CallStepFact[] = [
        { symbol: seed.name, file: seed.filePath, line: seed.startLine },
      ];
      const visited = new Set<string>([seed.id]);
      let currentId = seed.id;

      while (steps.length < MAX_CHAIN_STEPS) {
        let candidates: { node: CgNode }[] = [];
        try {
          candidates = cg.getCallees(currentId, 1) as { node: CgNode }[];
        } catch {
          break;
        }
        if (++scanned % YIELD_EVERY === 0) await breathe();

        const currentFile = steps[steps.length - 1].file;
        const next = candidates
          .map((c) => c.node)
          .filter((n) => n && !visited.has(n.id))
          .sort((a, b) => {
            const cross =
              Number(b.filePath !== currentFile) -
              Number(a.filePath !== currentFile);
            if (cross !== 0) return cross;
            return this.outDegree(cg, b.id) - this.outDegree(cg, a.id);
          })[0];

        if (!next) break;
        visited.add(next.id);
        currentId = next.id;
        steps.push({
          symbol: next.name,
          file: next.filePath,
          line: next.startLine,
        });
      }

      // A two-hop "chain" is a fact a table states better than a diagram does.
      if (steps.length >= MIN_CHAIN_STEPS) {
        chains.push({
          name: seed.name,
          entryFile: seed.filePath,
          steps,
        });
      }
    }

    if (chains.length === 0 && seeds.length > 0) {
      degraded.push('callChains: no path of 3+ real call edges found');
    }

    return chains;
  }

  /**
   * Where to start walking. Route handlers first — those are the paths a reader
   * cares about — then any exported function nothing calls, which in a library
   * or a frontend is the same idea wearing different clothes.
   */
  private chainSeeds(
    cg: CodeGraph,
    routes: RouteFact[],
    degraded: string[],
  ): CgNode[] {
    const seeds: CgNode[] = [];
    const seen = new Set<string>();

    const push = (n: CgNode | undefined): void => {
      if (!n || seen.has(n.id)) return;
      seen.add(n.id);
      seeds.push(n);
    };

    for (const route of routes) {
      try {
        // Match the handler by file + name; the manifest reports where it is but
        // not its node id, and names repeat across a repo.
        const inFile = cg.getNodesInFile(route.file) as CgNode[];
        push(
          inFile.find(
            (n) =>
              n.name === route.handler &&
              (n.kind === 'function' || n.kind === 'method'),
          ),
        );
      } catch {
        // A route whose file can't be read is not worth failing the pre-pass.
      }
    }

    if (seeds.length === 0) {
      const exported = this.safely(
        () =>
          (cg.getNodesByKind('function') as CgNode[])
            .filter((n) => n.isExported)
            .slice(0, MAX_CHAIN_SEEDS * 2),
        [] as CgNode[],
        'callChains.seeds',
        degraded,
      );
      // Most-connected first: an exported symbol that calls nothing is a leaf,
      // and a chain seeded there is one hop long.
      for (const n of exported
        .sort((a, b) => this.outDegree(cg, b.id) - this.outDegree(cg, a.id))
        .slice(0, MAX_CHAIN_SEEDS)) {
        push(n);
      }
    }

    return seeds;
  }

  /** Cheap "how much does this symbol do" signal — one indexed edge lookup. */
  private outDegree(cg: CodeGraph, nodeId: string): number {
    try {
      return cg.getOutgoingEdges(nodeId).filter((e) => e.kind === 'calls')
        .length;
    } catch {
      return 0;
    }
  }

  // ── External packages ─────────────────────────────────────────────────────

  /**
   * `module -> third-party package` edges, from `import` nodes.
   *
   * `getFileDependencies` only returns specifiers that resolved to an indexed
   * file, so third-party imports are invisible to it — which is why the
   * dependency diagram was a grid of names with no edges. Import nodes carry the
   * raw specifier, so the edge is recoverable.
   *
   * Restricting to packages that are actually *declared* in the manifest is what
   * removes path aliases (`@app/common` looks exactly like a scoped package) and
   * Node builtins in one rule, rather than maintaining a blocklist of either.
   */
  private async externalImportFacts(
    cg: CodeGraph,
    fileToModule: Map<string, string>,
    dependencies: DependencyFact[],
    degraded: string[],
  ): Promise<ExternalImportFact[]> {
    if (dependencies.length === 0) return [];

    const declared = new Set(dependencies.map((d) => d.name));
    const imports = this.safely(
      () => cg.getNodesByKind('import') as CgNode[],
      [] as CgNode[],
      'externalImports',
      degraded,
    );

    const weights = new Map<string, Map<string, number>>();
    let scanned = 0;

    for (const node of imports) {
      const pkg = packageOf(node.name);
      if (!pkg || !declared.has(pkg)) continue;

      const module = fileToModule.get(node.filePath) ?? ROOT_MODULE;
      let row = weights.get(module);
      if (!row) {
        row = new Map<string, number>();
        weights.set(module, row);
      }
      row.set(pkg, (row.get(pkg) ?? 0) + 1);

      if (++scanned % YIELD_EVERY === 0) await breathe();
    }

    const edges: ExternalImportFact[] = [];
    for (const [module, row] of weights) {
      for (const [pkg, count] of row) {
        edges.push({ module, package: pkg, count });
      }
    }

    const sorted = edges.sort((a, b) => b.count - a.count);
    if (sorted.length > MAX_EXTERNAL_IMPORTS) {
      degraded.push(
        `externalImports: showing ${MAX_EXTERNAL_IMPORTS} of ${sorted.length}`,
      );
    }
    return sorted.slice(0, MAX_EXTERNAL_IMPORTS);
  }

  // ── Manifest ──────────────────────────────────────────────────────────────

  /**
   * Declared dependencies with their versions, parsed rather than recalled.
   *
   * The dependency agent was asked to transcribe `runtime_dependencies` from the
   * manifest text in its prompt, and did — but names only, no versions, and a
   * transcription an LLM performs is still a transcription that can drift. This
   * is the same list, for free, exactly right.
   */
  private async dependencyFacts(
    repoPath: string,
    degraded: string[],
  ): Promise<DependencyFact[]> {
    const out: DependencyFact[] = [];

    const pkg = await this.readJson(path.join(repoPath, 'package.json'));
    if (pkg) {
      for (const [scope, field] of [
        ['runtime', 'dependencies'],
        ['dev', 'devDependencies'],
      ] as const) {
        const block = pkg[field];
        if (!block || typeof block !== 'object') continue;
        for (const [name, version] of Object.entries(
          block as Record<string, unknown>,
        )) {
          out.push({ name, version: String(version), scope });
        }
      }
    }

    const requirements = await this.readText(
      path.join(repoPath, 'requirements.txt'),
    );
    if (requirements) {
      for (const line of requirements.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [name, version] = trimmed.split(/[=<>~!]+/);
        if (name) {
          out.push({
            name: name.trim(),
            version: version?.trim() || '*',
            scope: 'runtime',
          });
        }
      }
    }

    const goMod = await this.readText(path.join(repoPath, 'go.mod'));
    if (goMod) {
      for (const line of goMod.split('\n')) {
        const match = /^\s*([\w.\-/]+)\s+(v[\w.\-+]+)/.exec(line);
        if (match && !line.trim().startsWith('module ')) {
          out.push({ name: match[1], version: match[2], scope: 'runtime' });
        }
      }
    }

    if (out.length > MAX_DEPENDENCIES) {
      degraded.push(
        `dependencies: showing ${MAX_DEPENDENCIES} of ${out.length}`,
      );
    }
    return out.slice(0, MAX_DEPENDENCIES);
  }

  // ── Entry points ──────────────────────────────────────────────────────────

  /**
   * Where a reader starts, and how the thing is run. Scripts come from the
   * manifest; symbol entries come from the graph's own route nodes. Both are
   * facts, and "how do I run this" is the first question a report should answer
   * and the current one never does.
   */
  private async entryPointFacts(
    cg: CodeGraph,
    repoPath: string,
    degraded: string[],
  ): Promise<EntryPointFact[]> {
    const out: EntryPointFact[] = [];

    const pkg = await this.readJson(path.join(repoPath, 'package.json'));
    if (pkg) {
      const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
      const names = Object.keys(scripts).sort((a, b) => {
        const ai = SCRIPT_PRIORITY.indexOf(a);
        const bi = SCRIPT_PRIORITY.indexOf(b);
        return (
          (ai === -1 ? SCRIPT_PRIORITY.length : ai) -
          (bi === -1 ? SCRIPT_PRIORITY.length : bi)
        );
      });
      for (const name of names.slice(0, 6)) {
        out.push({
          kind: 'script',
          name: `npm run ${name}`,
          detail: String(scripts[name]),
        });
      }
      if (typeof pkg.main === 'string') {
        out.push({ kind: 'main', name: 'main', detail: pkg.main });
      }
      if (pkg.bin && typeof pkg.bin === 'object') {
        for (const [name, target] of Object.entries(
          pkg.bin as Record<string, unknown>,
        ).slice(0, 2)) {
          out.push({ kind: 'bin', name, detail: String(target) });
        }
      }
    }

    const routeNodes = this.safely(
      () => cg.getNodesByKind('route') as CgNode[],
      [] as CgNode[],
      'entryPoints.routes',
      degraded,
    );
    for (const n of routeNodes.slice(0, 4)) {
      out.push({
        kind: 'route',
        name: n.name,
        detail: `${n.filePath}:${n.startLine}`,
        file: n.filePath,
        line: n.startLine,
      });
    }

    return out.slice(0, MAX_ENTRY_POINTS);
  }

  // ── Manifest readers ──────────────────────────────────────────────────────

  /**
   * Read a repo file. The path is always built here from `repoPath` plus a
   * hardcoded literal filename — never from anything the analysed repository or
   * a user supplied — so this cannot be steered outside the extracted checkout.
   */
  private async readText(absPath: string): Promise<string | null> {
    try {
      return await fs.readFile(absPath, 'utf-8');
    } catch {
      return null;
    }
  }

  private async readJson(
    absPath: string,
  ): Promise<Record<string, unknown> | null> {
    const raw = await this.readText(absPath);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      // A repo with a malformed package.json is a repo we still analyse.
      return null;
    }
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

/**
 * The subset of CodeGraph's `Node` this file reads. Declared locally rather than
 * imported because the package exports its types from a deep path and this is
 * the whole surface we touch.
 */
interface CgNode {
  id: string;
  kind: string;
  name: string;
  filePath: string;
  startLine: number;
  isExported?: boolean;
}

/**
 * Bare package name from an import specifier: `@scope/pkg/sub` -> `@scope/pkg`,
 * `lodash/merge` -> `lodash`. Returns null for anything relative — those are
 * internal edges and belong to the module graph, not the dependency graph.
 */
function packageOf(specifier: string): string | null {
  const s = String(specifier ?? '').trim();
  if (!s || s.startsWith('.') || s.startsWith('/')) return null;

  const parts = s.split('/');
  return s.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
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
