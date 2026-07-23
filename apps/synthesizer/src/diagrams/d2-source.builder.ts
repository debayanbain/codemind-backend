import { Injectable } from '@nestjs/common';
import {
  ArchitectureOutput,
  SecurityOutput,
  DependencyOutput,
  CallChainFact,
  ExternalImportFact,
} from '@app/common';
import { NodeStyle, PALETTE } from './palette';

/**
 * How many nodes a D2 source declares.
 *
 * Used to drop degenerate diagrams before they are rendered. A two-box
 * "authentication flow" is not a small diagram, it is a missing one wearing a
 * diagram's clothes — it tells the reader the analysis is complete when it
 * isn't. Better to fall back to the table.
 *
 * The regex matches exactly what `node()` emits (`id: "label"`, optionally
 * followed by a style block) and nothing else: `style.fill: "…"` has a dot,
 * `direction: right` has no quote, and edges have a space before the colon.
 */
export function countNodes(source: string): number {
  return (source.match(/^[ \t]*[A-Za-z_][A-Za-z0-9_]*:[ \t]*"/gm) ?? []).length;
}

/**
 * Agent JSON -> D2 source. Pure TypeScript, zero LLM calls.
 *
 * The LLM never writes diagram syntax. It emits structured facts
 * (`module_dependencies[]`, `auth_flow_steps[]`); this file turns those into a
 * diagram. That's what makes the diagrams non-hallucinatable: a node can only
 * appear if a real CodeGraph node backed it.
 *
 * Risk is encoded as fill colour AND a text prefix, never colour alone.
 */
@Injectable()
export class D2SourceBuilder {
  /** Caps keep both the diagram legible and the SVG small. */
  private static readonly MAX_MODULES = 15;
  private static readonly MAX_EDGES = 20;
  private static readonly MAX_DEPS = 15;
  private static readonly MAX_STEPS = 8;
  private static readonly MAX_VULNS = 4;
  private static readonly MAX_LABEL = 48;
  /** System-flow caps — this diagram's whole value is that it fits on one line. */
  private static readonly MAX_FLOW_STEPS = 6;
  private static readonly MAX_FLOW_DEPS = 3;
  /** Dependency-graph caps once it has real edges to draw. */
  private static readonly MAX_DEP_MODULES = 6;
  private static readonly MAX_DEP_PACKAGES = 12;
  private static readonly MAX_DEP_EDGES = 18;

  // ─── 0. System flow (measured) ─────────────────────────────────────────────

  /**
   * The end-to-end spine: entry → the symbols a request actually passes through
   * → the third-party packages it lands on.
   *
   * Built entirely from `RepoFacts`. Every hop is a `calls` edge the graph has,
   * and every package edge is an `import` node — so unlike every other flow
   * diagram this report has drawn, none of it can be an edge that doesn't exist.
   *
   * Each node is labelled `module › symbol`, so the reader sees where the path
   * crosses a module boundary, which is the part worth seeing.
   */
  systemFlow(
    chains: CallChainFact[],
    externalImports: ExternalImportFact[],
  ): string {
    const chain = [...chains].sort((a, b) => b.steps.length - a.steps.length)[0];
    if (!chain || chain.steps.length < 2) {
      return this.placeholder('No end-to-end call path measured');
    }

    const steps = chain.steps.slice(0, D2SourceBuilder.MAX_FLOW_STEPS);
    const ids = new IdAllocator('s');
    const lines = ['direction: right'];

    steps.forEach((step, i) => {
      const module = moduleOf(step.file);
      const key = `${module}/${step.symbol}#${i}`;
      lines.push(
        this.node(
          ids.get(key),
          `${module} › ${step.symbol}`,
          i === 0 ? PALETTE.entry : undefined,
        ),
      );
      if (i > 0) {
        lines.push(
          this.edge(ids.get(`${moduleOf(steps[i - 1].file)}/${steps[i - 1].symbol}#${i - 1}`), ids.get(key), `${i}`),
        );
      }
    });

    // What the far end of the path reaches for. Scoped to the modules the chain
    // actually touches — the top packages repo-wide would be a different, less
    // honest claim.
    const touched = new Set(steps.map((s) => moduleOf(s.file)));
    const reached = externalImports
      .filter((e) => touched.has(e.module))
      .sort((a, b) => b.count - a.count)
      .slice(0, D2SourceBuilder.MAX_FLOW_DEPS);

    if (reached.length > 0) {
      const lastKey = `${moduleOf(steps[steps.length - 1].file)}/${steps[steps.length - 1].symbol}#${steps.length - 1}`;
      for (const dep of reached) {
        const id = ids.get(`pkg:${dep.package}`);
        lines.push(this.node(id, dep.package, PALETTE.muted));
        lines.push(this.edge(ids.get(lastKey), id, 'uses'));
      }
    }

    return lines.join('\n');
  }

  // ─── 1. Module dependency graph (architecture agent) ───────────────────────

  moduleGraph(arch: ArchitectureOutput): string {
    const deps = (arch.module_dependencies ?? []).filter((d) => d.from && d.to);
    const declared = arch.modules ?? [];

    // Nodes are directory/layer modules — NOT entry-point files (those are
    // file-level now and would dangle disconnected in a module graph; they're
    // listed separately in the report). The node set is the declared modules
    // plus anything an edge references, so no edge ever points at an
    // undeclared, unstyled auto-created node.
    const nodeSet = new Set<string>(declared);
    for (const { from, to } of deps) {
      nodeSet.add(from);
      nodeSet.add(to);
    }

    if (nodeSet.size === 0) {
      return this.placeholder('Module graph not available');
    }

    // A module with no incoming edge is a root of the wiring (an entry layer) —
    // style it like an entry point so the graph reads top-down at a glance.
    const hasIncoming = new Set(deps.map((d) => d.to));

    const ids = new IdAllocator('m');
    const lines = ['direction: right'];

    // Declare the wiring roots first. Layout engines break ties on declaration
    // order, so this is what makes the graph read as layers — entry modules on
    // one side, the things they lean on downstream — instead of arbitrarily.
    const ordered = [...nodeSet].sort(
      (a, b) => Number(hasIncoming.has(a)) - Number(hasIncoming.has(b)),
    );

    for (const m of ordered.slice(0, D2SourceBuilder.MAX_MODULES)) {
      lines.push(
        this.node(
          ids.get(m),
          m,
          hasIncoming.has(m) ? undefined : PALETTE.entry,
        ),
      );
    }
    for (const { from, to, label } of deps.slice(
      0,
      D2SourceBuilder.MAX_EDGES,
    )) {
      // Skip edges whose endpoints were dropped by the node cap — resolving
      // them through the allocator would silently resurrect a dangling node.
      if (!ids.has(from) || !ids.has(to)) continue;
      lines.push(this.edge(ids.get(from), ids.get(to), label));
    }

    return lines.join('\n');
  }

  // ─── 2. Request flow ───────────────────────────────────────────────────────

  /**
   * A sequence diagram whose arrows are real call edges.
   *
   * The string-based `sequenceDiagram` below draws whatever order the model
   * listed its steps in, which is how the reference report ended up with
   * `setAgentStatus -> getJob` — two symbols named in sequence, not a call. This
   * takes a chain the graph traced, so every arrow is an edge that exists.
   */
  sequenceFromChain(chain: CallChainFact): string {
    const steps = chain.steps.slice(0, D2SourceBuilder.MAX_STEPS);
    if (steps.length < 2) {
      return this.placeholder('Request flow not available');
    }

    const ids = new IdAllocator('p');
    const lines = ['shape: sequence_diagram'];

    // Key on file+symbol, not symbol alone: two different `handle` functions in
    // two files are two participants, and merging them draws a self-call that
    // isn't in the code.
    const keyOf = (s: { symbol: string; file: string }): string =>
      `${s.file}::${s.symbol}`;

    const seen = new Set<string>();
    for (const step of steps) {
      const id = ids.get(keyOf(step));
      if (seen.has(id)) continue;
      seen.add(id);
      lines.push(this.node(id, `${step.symbol} (${moduleOf(step.file)})`));
    }

    for (let i = 0; i < steps.length - 1; i++) {
      lines.push(
        this.edge(ids.get(keyOf(steps[i])), ids.get(keyOf(steps[i + 1])), `${i + 1}`),
      );
    }

    const first = ids.get(keyOf(steps[0]));
    const last = ids.get(keyOf(steps[steps.length - 1]));
    if (first !== last) {
      lines.push(`${last} -> ${first}: "returns" { style.stroke-dash: 3 }`);
    }

    return lines.join('\n');
  }

  sequenceDiagram(steps: string[]): string {
    if (!steps || steps.length < 2) {
      return this.placeholder('Request flow not available');
    }

    const capped = steps.slice(0, D2SourceBuilder.MAX_STEPS);
    const ids = new IdAllocator('p');
    const lines = ['shape: sequence_diagram'];

    // Declare participants up front so D2 fixes their left-to-right order to
    // the order they're first touched by the flow, not to edge-discovery order.
    const seen = new Set<string>();
    for (const step of capped) {
      const id = ids.get(step);
      if (seen.has(id)) continue;
      seen.add(id);
      lines.push(this.node(id, step));
    }

    for (let i = 0; i < capped.length - 1; i++) {
      lines.push(
        this.edge(ids.get(capped[i]), ids.get(capped[i + 1]), `${i + 1}`),
      );
    }
    // Only synthesise a return arrow when the flow doesn't already come back to
    // where it started. Agents routinely end a flow on the caller ("Client →
    // API → … → Client"); adding one anyway draws a self-loop dangling off the
    // last participant, which reads as a step that doesn't exist in the code.
    const first = ids.get(capped[0]);
    const last = ids.get(capped[capped.length - 1]);
    if (first !== last) {
      lines.push(`${last} -> ${first}: "response" { style.stroke-dash: 3 }`);
    }

    return lines.join('\n');
  }

  // ─── 3. Auth flow + vulnerabilities (security agent) ───────────────────────

  securityFlow(sec: SecurityOutput): string {
    const steps = sec.auth_flow_steps ?? [];
    const vulns = (sec.vulnerabilities ?? []).filter(
      (v) => v.severity === 'critical' || v.severity === 'high',
    );

    if (steps.length === 0 && vulns.length === 0) {
      return this.placeholder('Auth flow not detected');
    }

    const lines = ['direction: down'];

    steps.forEach((step, i) => {
      const style =
        i === 0
          ? PALETTE.entry
          : i === steps.length - 1
            ? PALETTE.ok
            : undefined;
      lines.push(this.node(`a_${i}`, step, style));
      if (i > 0) lines.push(this.edge(`a_${i - 1}`, `a_${i}`));
    });

    if (vulns.length > 0) {
      lines.push('vulns: "High / Critical Issues" {');
      lines.push('  style.stroke: "#A63603"');
      lines.push('  style.stroke-dash: 3');
      vulns.slice(0, D2SourceBuilder.MAX_VULNS).forEach((v, i) => {
        const label = `${v.severity.toUpperCase()}: ${v.type} @ ${v.location}`;
        lines.push(this.node(`v_${i}`, label, PALETTE.critical, '  '));
      });
      lines.push('}');
    }

    return lines.join('\n');
  }

  // ─── 4. Dependency graph (dependency agent) ────────────────────────────────

  dependencyGraph(
    dep: DependencyOutput,
    externalImports: ExternalImportFact[] = [],
  ): string {
    const runtime = dep.runtime_dependencies ?? [];
    const critical = new Set(dep.critical_deps ?? []);
    const outdated = new Set((dep.outdated_risks ?? []).map((r) => r.package));

    // Real edges when we measured them. Before this, the "dependency graph" was
    // a grid of package names with no edges at all — the one diagram in the
    // report that wasn't a graph. `module -> package` edges come from import
    // nodes, so each one is an import that exists, weighted by how many.
    if (externalImports.length > 0) {
      return this.dependencyEdgeGraph(externalImports, critical, outdated);
    }

    if (runtime.length === 0) {
      return this.placeholder('Dependency info not available');
    }

    const ids = new IdAllocator('d');

    // A grid, not a star. There are no real edges *between* packages — only
    // app→package — so fanning 15 nodes out of a single root draws 15 identical
    // arrows that carry no information and stretch the diagram far off the page.
    // The grid states exactly as much, compactly, and prints on one sheet.
    const lines = [
      'direction: down',
      this.node('app', 'This App', PALETTE.root),
      `deps: "Runtime dependencies (${runtime.length})" {`,
      '  grid-columns: 3',
    ];

    for (const pkg of runtime.slice(0, D2SourceBuilder.MAX_DEPS)) {
      const isCritical = critical.has(pkg);
      const isOutdated = outdated.has(pkg);

      // Text prefix, not just fill — greyscale printouts and colourblind
      // readers get the same information the colour carries.
      const tags: string[] = [];
      if (isCritical) tags.push('CRITICAL');
      if (isOutdated) tags.push('OUTDATED');
      const label = tags.length ? `[${tags.join(' + ')}] ${pkg}` : pkg;

      let style: NodeStyle | undefined;
      if (isCritical && isOutdated) style = PALETTE.critical;
      else if (isCritical) style = PALETTE.entry;
      else if (isOutdated) style = PALETTE.warning;

      lines.push(this.node(ids.get(pkg), label, style, '  '));
    }

    const overflow = runtime.length - D2SourceBuilder.MAX_DEPS;
    if (overflow > 0) {
      lines.push(this.node('more', `+${overflow} more`, PALETTE.muted, '  '));
    }

    lines.push('}');
    lines.push(this.edge('app', 'deps'));

    return lines.join('\n');
  }

  /**
   * `module -> package`, weighted by import count.
   *
   * Keeping the busiest modules and the packages they reach (rather than the
   * top packages overall) is what keeps this small AND connected: every package
   * drawn has at least one edge into a module that is also drawn, so there are
   * no floating nodes.
   */
  private dependencyEdgeGraph(
    externalImports: ExternalImportFact[],
    critical: Set<string>,
    outdated: Set<string>,
  ): string {
    const byModule = new Map<string, number>();
    for (const e of externalImports) {
      byModule.set(e.module, (byModule.get(e.module) ?? 0) + e.count);
    }
    const modules = new Set(
      [...byModule.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, D2SourceBuilder.MAX_DEP_MODULES)
        .map(([m]) => m),
    );

    const edges = externalImports
      .filter((e) => modules.has(e.module))
      .sort((a, b) => b.count - a.count)
      .slice(0, D2SourceBuilder.MAX_DEP_EDGES);

    const packages = [...new Set(edges.map((e) => e.package))].slice(
      0,
      D2SourceBuilder.MAX_DEP_PACKAGES,
    );
    const keptPackages = new Set(packages);

    const ids = new IdAllocator('d');
    const lines = ['direction: right'];

    for (const m of modules) {
      lines.push(this.node(ids.get(`mod:${m}`), m, PALETTE.root));
    }

    for (const pkg of packages) {
      const isCritical = critical.has(pkg);
      const isOutdated = outdated.has(pkg);

      // Text prefix, not just fill — greyscale printouts and colourblind
      // readers get the same information the colour carries.
      const tags: string[] = [];
      if (isCritical) tags.push('CRITICAL');
      if (isOutdated) tags.push('OUTDATED');
      const label = tags.length ? `[${tags.join(' + ')}] ${pkg}` : pkg;

      let style: NodeStyle | undefined;
      if (isCritical && isOutdated) style = PALETTE.critical;
      else if (isCritical) style = PALETTE.entry;
      else if (isOutdated) style = PALETTE.warning;

      lines.push(this.node(ids.get(`pkg:${pkg}`), label, style));
    }

    for (const e of edges) {
      if (!keptPackages.has(e.package)) continue;
      lines.push(
        this.edge(ids.get(`mod:${e.module}`), ids.get(`pkg:${e.package}`), `${e.count}`),
      );
    }

    return lines.join('\n');
  }

  // ─── Emitters ──────────────────────────────────────────────────────────────

  private node(
    id: string,
    label: string,
    style?: NodeStyle,
    indent = '',
  ): string {
    const safe = this.label(label);
    if (!style) return `${indent}${id}: "${safe}"`;
    return [
      `${indent}${id}: "${safe}" {`,
      `${indent}  style.fill: "${style.fill}"`,
      `${indent}  style.font-color: "${style.text}"`,
      `${indent}  style.stroke: "${style.stroke}"`,
      `${indent}  style.stroke-width: 2`,
      `${indent}}`,
    ].join('\n');
  }

  private edge(from: string, to: string, label?: string): string {
    return label
      ? `${from} -> ${to}: "${this.label(label)}"`
      : `${from} -> ${to}`;
  }

  /**
   * Labels come from LLM output, so they can contain anything. D2 treats `"`
   * and `\` as syntax inside a quoted string — an unescaped one doesn't just
   * mangle the label, it breaks the compile and costs the whole diagram.
   * Strip rather than escape: these are display labels, not data.
   */
  private label(raw: string): string {
    const cleaned = String(raw ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/["\\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return 'unknown';
    return cleaned.length > D2SourceBuilder.MAX_LABEL
      ? `${cleaned.slice(0, D2SourceBuilder.MAX_LABEL - 1)}…`
      : cleaned;
  }

  private placeholder(message: string): string {
    return this.node('empty', message, PALETTE.muted);
  }
}

/** Top-level directory of a repo-relative path — the module a symbol lives in. */
function moduleOf(filePath: string): string {
  const first = String(filePath ?? '').split('/')[0];
  return first && first !== filePath ? first : '(root)';
}

/**
 * Maps arbitrary label text to a stable, unique, D2-safe identifier.
 *
 * Two things force this. D2 identifiers can't contain `/`, `.`, spaces, etc.,
 * so `src/auth/jwt.ts` has to be flattened — but flattening is lossy, and
 * `src/auth` and `src.auth` would collide into the same node and silently merge
 * two unrelated modules into one. The counter suffix makes collisions
 * impossible. The `n_`-style prefix keeps ids clear of D2 reserved keywords
 * (`style`, `shape`, `direction`, `label`, `near`, `grid-rows`, ...).
 */
class IdAllocator {
  private readonly byLabel = new Map<string, string>();
  private readonly taken = new Set<string>();

  constructor(private readonly prefix: string) {}

  /** True if this label already has an allocated id (without allocating one). */
  has(label: string): boolean {
    return this.byLabel.has(label);
  }

  get(label: string): string {
    const existing = this.byLabel.get(label);
    if (existing) return existing;

    const base = `${this.prefix}_${
      String(label)
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'x'
    }`;

    let id = base;
    let n = 1;
    while (this.taken.has(id)) id = `${base}_${n++}`;

    this.taken.add(id);
    this.byLabel.set(label, id);
    return id;
  }
}
