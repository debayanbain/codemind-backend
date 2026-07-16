import type { RepoFacts } from '@app/common';

/**
 * Renders RepoFacts into a prompt block.
 *
 * This block is **ground truth**, and it is framed that way to the model on
 * purpose. Every line in it came from the AST, so the model's job changes from
 * "guess what the modules are" to "explain what these modules do" — which is the
 * part it is actually good at, and the part that can't be computed.
 *
 * Each agent takes only the slices it needs. Sending routes to the docs agent or
 * complexity metrics to the dependency agent is just tokens.
 */
export type FactSection =
  | 'overview'
  | 'modules'
  | 'moduleEdges'
  | 'routes'
  | 'hotspots'
  | 'cycles'
  | 'deadCode';

const MAX_LINE_ITEMS = 20;

export function renderFacts(
  facts: RepoFacts,
  sections: readonly FactSection[],
): string {
  const parts: string[] = [];

  for (const section of sections) {
    const rendered = RENDERERS[section](facts);
    if (rendered) parts.push(rendered);
  }

  if (!parts.length) return '';

  return [
    '## Ground Truth (from AST analysis — these are FACTS, not guesses)',
    '',
    'The following was extracted directly from the code graph. It is accurate.',
    'Do NOT contradict it, and do NOT re-derive it — build your analysis on top',
    'of it and spend your effort on what it cannot tell you: why the code is',
    'shaped this way, and what is wrong with it.',
    '',
    ...parts,
  ].join('\n');
}

const RENDERERS: Record<FactSection, (f: RepoFacts) => string> = {
  overview: (f) => {
    const langs = f.languages
      .slice(0, 5)
      .map((l) => `${l.language} (${l.files})`)
      .join(', ');
    return [
      '### Repository',
      `- Files indexed: ${f.stats.files}`,
      `- Graph nodes: ${f.stats.nodes}, edges: ${f.stats.edges}`,
      `- Lines of code: ${f.stats.linesOfCode}`,
      `- Languages by file count: ${langs || 'unknown'}`,
      `- Frameworks detected: ${f.frameworks.length ? f.frameworks.join(', ') : 'none detected'}`,
      `- Routes found: ${f.totalRoutes}`,
      '',
    ].join('\n');
  },

  modules: (f) => {
    if (!f.modules.length) return '';
    const rows = f.modules.map(
      (m) =>
        `| ${m.name} | ${m.files} | ${m.linesOfCode} | ${
          m.exports.slice(0, 6).join(', ') || '—'
        } |`,
    );
    return [
      '### Modules (top-level source directories, by size)',
      '| Module | Files | LOC | Notable exports |',
      '|---|---|---|---|',
      ...rows,
      '',
    ].join('\n');
  },

  moduleEdges: (f) => {
    if (!f.moduleDependencies.length) return '';
    const rows = f.moduleDependencies
      .slice(0, MAX_LINE_ITEMS)
      .map((e) => `- ${e.from} -> ${e.to} (${e.weight} imports)`);
    return [
      '### Real module dependencies (aggregated from actual imports)',
      ...rows,
      '',
    ].join('\n');
  },

  routes: (f) => {
    if (!f.routes.length) return '';
    const rows = f.routes
      .slice(0, MAX_LINE_ITEMS)
      .map((r) => `- ${r.url} -> ${r.handler} (${r.file}:${r.line})`);
    return [`### Real routes (${f.totalRoutes} total)`, ...rows, ''].join('\n');
  },

  hotspots: (f) => {
    if (!f.complexityHotspots.length) return '';
    const rows = f.complexityHotspots.map(
      (h) =>
        `- ${h.symbol} (${h.file}:${h.line}) — ${h.callers} callers, ${h.callees} callees, depth ${h.depth}`,
    );
    return [
      '### Measured complexity hotspots (most-connected symbols)',
      ...rows,
      '',
    ].join('\n');
  },

  cycles: (f) => {
    if (!f.circularDependencies.length) return '';
    const rows = f.circularDependencies.map((c) => `- ${c.join(' -> ')}`);
    return ['### Circular dependencies (real)', ...rows, ''].join('\n');
  },

  deadCode: (f) => {
    if (!f.deadCode.length) return '';
    const rows = f.deadCode
      .slice(0, MAX_LINE_ITEMS)
      .map((d) => `- ${d.kind} ${d.symbol} (${d.file}:${d.line})`);
    return ['### Unreferenced symbols (possible dead code)', ...rows, ''].join(
      '\n',
    );
  },
};
