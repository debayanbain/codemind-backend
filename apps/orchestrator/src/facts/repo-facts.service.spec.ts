import { RepoFactsService } from './repo-facts.service';
import type CodeGraph from '@colbymchenry/codegraph';

jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue('line\nline\nline'),
}));

type GraphStub = Partial<Record<keyof CodeGraph, unknown>>;

const node = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  kind: 'function',
  name: 'handler',
  qualifiedName: 'f::handler',
  filePath: 'apps/api/a.ts',
  language: 'typescript',
  startLine: 10,
  endLine: 20,
  ...over,
});

const baseGraph = (over: GraphStub = {}): CodeGraph =>
  ({
    getFiles: () => [
      { path: 'apps/api/a.ts', size: 100 },
      { path: 'apps/api/b.ts', size: 100 },
      { path: 'libs/common/c.ts', size: 100 },
      { path: 'README.md', size: 10 },
    ],
    getStats: () => ({
      fileCount: 4,
      nodeCount: 40,
      edgeCount: 12,
      filesByLanguage: { typescript: 3, unknown: 1 },
      nodesByKind: {},
      edgesByKind: {},
    }),
    getDetectedFrameworks: () => ['nestjs'],
    getRoutingManifest: () => null,
    getNodesInFile: () => [],
    getFileDependencies: () => [],
    findCircularDependencies: () => [],
    findDeadCode: () => [],
    getNodeMetrics: () => ({
      incomingEdgeCount: 0,
      outgoingEdgeCount: 0,
      callCount: 0,
      callerCount: 0,
      childCount: 0,
      depth: 0,
    }),
    ...over,
  }) as unknown as CodeGraph;

describe('RepoFactsService', () => {
  const service = new RepoFactsService();

  it('reports counts the report can quote without a model ever seeing them', async () => {
    const f = await service.build(baseGraph(), '/tmp/repos/j-0', 'j-0');

    expect(f.stats).toMatchObject({ files: 4, nodes: 40, edges: 12 });
    expect(f.frameworks).toEqual(['nestjs']);
    expect(f.dominantLanguage).toBe('typescript');
    expect(f.runKey).toBe('j-0');
  });

  it('derives module edges from real imports, aggregated and weighted', async () => {
    // This is the fact that replaces the architecture agent's invented
    // module_dependencies[] — the array that draws diagram #1. Two files in
    // apps/api both importing libs/common is ONE module edge of weight 2, not
    // two edges and not a guess.
    const graph = baseGraph({
      getFileDependencies: (p: string) =>
        p.startsWith('apps/api/') ? ['libs/common/c.ts'] : [],
    });

    const f = await service.build(graph, '/tmp/repos/j-0', 'j-0');

    expect(f.moduleDependencies).toEqual([
      { from: 'apps', to: 'libs', weight: 2 },
    ]);
  });

  it('ignores imports that leave the repo', async () => {
    // node_modules paths aren't in the graph's file list, so they map to no
    // module. Third-party deps are the dependency agent's job; the module graph
    // is about this repo's own wiring.
    const graph = baseGraph({
      getFileDependencies: () => ['node_modules/rxjs/index.js'],
    });

    const f = await service.build(graph, '/tmp/repos/j-0', 'j-0');
    expect(f.moduleDependencies).toEqual([]);
  });

  it('never emits a self-edge', async () => {
    const graph = baseGraph({
      getFileDependencies: (p: string) =>
        p === 'apps/api/a.ts' ? ['apps/api/b.ts'] : [],
    });

    const f = await service.build(graph, '/tmp/repos/j-0', 'j-0');
    expect(f.moduleDependencies).toEqual([]);
  });

  it('ranks hotspots by measured connectivity, not by looks', async () => {
    const graph = baseGraph({
      getNodesInFile: (p: string) =>
        p === 'apps/api/a.ts'
          ? [
              node({ id: 'hot', name: 'hotFn' }),
              node({ id: 'cold', name: 'coldFn' }),
            ]
          : [],
      getNodeMetrics: (id: string) =>
        id === 'hot'
          ? {
              incomingEdgeCount: 0,
              outgoingEdgeCount: 0,
              callCount: 9,
              callerCount: 9,
              childCount: 0,
              depth: 3,
            }
          : {
              incomingEdgeCount: 0,
              outgoingEdgeCount: 0,
              callCount: 0,
              callerCount: 1,
              childCount: 0,
              depth: 0,
            },
    });

    const f = await service.build(graph, '/tmp/repos/j-0', 'j-0');

    expect(f.complexityHotspots[0]).toMatchObject({
      symbol: 'hotFn',
      callers: 9,
      callees: 9,
      file: 'apps/api/a.ts',
      line: 10,
    });
  });

  it('surfaces a fact it could not compute instead of reporting an empty one', async () => {
    // An empty `circularDependencies` must mean "there are none", not "the call
    // threw". Silently returning [] would let the report assert a clean bill of
    // health it never checked.
    const graph = baseGraph({
      findCircularDependencies: () => {
        throw new Error('graph busted');
      },
    });

    const f = await service.build(graph, '/tmp/repos/j-0', 'j-0');

    expect(f.circularDependencies).toEqual([]);
    expect(f.degraded).toContain('circularDependencies');
  });

  it('groups root-level files under a distinct module rather than dropping them', async () => {
    const f = await service.build(baseGraph(), '/tmp/repos/j-0', 'j-0');
    expect(f.modules.map((m) => m.name).sort()).toEqual([
      '(root)',
      'apps',
      'libs',
    ]);
  });
});
