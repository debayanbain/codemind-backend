import { Injectable } from '@nestjs/common';
import {
  ArchitectureOutput,
  SecurityOutput,
  DependencyOutput,
} from '@app/common';
import { NodeStyle, PALETTE } from './palette';

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

  // ─── 1. Module dependency graph (architecture agent) ───────────────────────

  moduleGraph(arch: ArchitectureOutput): string {
    const deps = arch.module_dependencies ?? [];
    const modules = arch.modules ?? [];
    const entries = arch.entry_points ?? [];

    if (modules.length === 0 && deps.length === 0) {
      return this.placeholder('Module graph not available');
    }

    const ids = new IdAllocator('m');
    const lines = ['direction: right'];

    for (const ep of entries.slice(0, 3)) {
      lines.push(this.node(ids.get(ep), ep, PALETTE.entry));
    }
    for (const m of modules.slice(0, D2SourceBuilder.MAX_MODULES)) {
      if (entries.includes(m)) continue;
      lines.push(this.node(ids.get(m), m));
    }
    for (const { from, to, label } of deps.slice(
      0,
      D2SourceBuilder.MAX_EDGES,
    )) {
      if (!from || !to) continue;
      lines.push(this.edge(ids.get(from), ids.get(to), label));
    }

    return lines.join('\n');
  }

  // ─── 2. Request flow (architecture agent) ──────────────────────────────────

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

  dependencyGraph(dep: DependencyOutput): string {
    const runtime = dep.runtime_dependencies ?? [];
    const critical = new Set(dep.critical_deps ?? []);
    const outdated = new Set((dep.outdated_risks ?? []).map((r) => r.package));

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
