import { D2SourceBuilder, countNodes } from './d2-source.builder';

describe('D2SourceBuilder', () => {
  const builder = new D2SourceBuilder();

  describe('identifier safety', () => {
    it('gives distinct ids to labels that flatten identically', () => {
      // `src/auth` and `src.auth` both sanitise to `m_src_auth`. Without a
      // collision counter they'd merge into one node, silently claiming two
      // unrelated modules are the same module.
      const src = builder.moduleGraph({
        modules: ['src/auth', 'src.auth'],
        module_dependencies: [{ from: 'src/auth', to: 'src.auth' }],
      });

      expect(src).toContain('m_src_auth:');
      expect(src).toContain('m_src_auth_1:');
      expect(src).toContain('m_src_auth -> m_src_auth_1');
    });

    it('prefixes ids so D2 reserved keywords are never emitted bare', () => {
      const src = builder.moduleGraph({ modules: ['style', 'shape', 'label'] });

      expect(src).toContain('m_style:');
      expect(src).toContain('m_shape:');
      expect(src).toContain('m_label:');
      expect(src).not.toMatch(/^style:/m);
    });
  });

  describe('label sanitisation', () => {
    it('strips quotes and backslashes that would break the D2 parse', () => {
      const src = builder.moduleGraph({ modules: ['a"b\\c'] });

      expect(src).toContain('"abc"');
    });

    it('truncates labels rather than emitting an unbounded one', () => {
      const src = builder.moduleGraph({ modules: ['x'.repeat(200)] });
      const label = /"([^"]*)"/.exec(src)?.[1] ?? '';

      expect(label.length).toBeLessThanOrEqual(48);
      expect(label.endsWith('…')).toBe(true);
    });

    it('falls back to a placeholder for an empty label', () => {
      const src = builder.moduleGraph({ modules: ['   '] });

      expect(src).toContain('"unknown"');
    });
  });

  describe('moduleGraph', () => {
    it('degrades to a placeholder when the agent found nothing', () => {
      expect(builder.moduleGraph({})).toContain('Module graph not available');
    });

    it('does not inject entry-point files as graph nodes', () => {
      // Entry points are file-level now; the module graph is dir/layer-level,
      // so an entry file that is not itself a module must not appear as a node.
      const src = builder.moduleGraph({
        entry_points: ['src/main.ts'],
        modules: ['api', 'common'],
        module_dependencies: [{ from: 'api', to: 'common' }],
      });

      expect(src).not.toContain('m_src_main_ts');
      expect(src).toContain('m_api -> m_common');
    });

    it('styles a root module (no incoming edge) as an entry layer', () => {
      const src = builder.moduleGraph({
        modules: ['api', 'common'],
        module_dependencies: [{ from: 'api', to: 'common' }],
      });

      // `api` is a root → gets an entry-styled block with fill; `common` is a
      // plain node. The entry palette fill only attaches to the root's block.
      const apiBlock = /m_api: "api" \{[^}]*\}/.exec(src)?.[0] ?? '';
      expect(apiBlock).toContain('style.fill');
    });

    it('skips edges with a missing endpoint', () => {
      const src = builder.moduleGraph({
        modules: ['a'],
        module_dependencies: [{ from: 'a', to: '' }],
      });

      expect(src).not.toContain('->');
    });
  });

  describe('dependencyGraph', () => {
    it('encodes risk as a text prefix, not colour alone', () => {
      const src = builder.dependencyGraph({
        runtime_dependencies: ['safe', 'crit', 'old', 'both'],
        critical_deps: ['crit', 'both'],
        outdated_risks: [
          { package: 'old', reason: 'stale' },
          { package: 'both', reason: 'cve' },
        ],
      });

      expect(src).toContain('[CRITICAL] crit');
      expect(src).toContain('[OUTDATED] old');
      expect(src).toContain('[CRITICAL + OUTDATED] both');
      expect(src).toContain('"safe"');
    });

    it('collapses the tail into an overflow node', () => {
      const src = builder.dependencyGraph({
        runtime_dependencies: Array.from({ length: 18 }, (_, i) => `p${i}`),
      });

      expect(src).toContain('+3 more');
      expect(src).toContain('Runtime dependencies (18)');
    });

    it('lays packages out as a grid, not as edges from a root', () => {
      // 15 identical app→package arrows convey nothing and blow the diagram
      // off the page. One edge, into a grid container.
      const src = builder.dependencyGraph({
        runtime_dependencies: ['a', 'b', 'c'],
      });

      expect(src).toContain('grid-columns: 3');
      expect(src.match(/->/g)).toHaveLength(1);
      expect(src).toContain('app -> deps');
    });
  });

  describe('sequenceDiagram', () => {
    it('needs at least two steps to be a sequence', () => {
      expect(builder.sequenceDiagram(['only'])).toContain(
        'Request flow not available',
      );
    });

    it('declares each participant once even when a step repeats', () => {
      const src = builder.sequenceDiagram(['Client', 'API', 'Client']);

      expect(src).toContain('shape: sequence_diagram');
      expect(src.match(/^p_Client: /gm)).toHaveLength(1);
    });

    it('adds a return arrow only when the flow does not already return', () => {
      const returns = builder.sequenceDiagram(['Client', 'API', 'Client']);
      const oneWay = builder.sequenceDiagram(['Client', 'API', 'DB']);

      // A flow ending where it began already shows the response; synthesising
      // another draws a self-loop for a step that doesn't exist.
      expect(returns).not.toContain('response');
      expect(oneWay).toContain('p_DB -> p_Client: "response"');
    });
  });

  describe('securityFlow', () => {
    it('shows only high and critical vulnerabilities', () => {
      const src = builder.securityFlow({
        auth_flow_steps: ['Browser', 'Guard'],
        vulnerabilities: [
          {
            type: 'XSS',
            location: 'a.ts',
            severity: 'critical',
            description: '',
          },
          { type: 'Nit', location: 'b.ts', severity: 'low', description: '' },
        ],
      });

      expect(src).toContain('CRITICAL: XSS');
      expect(src).not.toContain('Nit');
    });

    it('degrades when there is neither a flow nor a finding', () => {
      expect(builder.securityFlow({})).toContain('Auth flow not detected');
    });
  });

  describe('countNodes', () => {
    it('counts node declarations and nothing else', () => {
      // This gates whether a diagram is drawn at all, so it must not count
      // style properties, layout directives or edges as nodes.
      const src = [
        'direction: right',
        'a: "A"',
        'b: "B" {',
        '  style.fill: "#000"',
        '  style.stroke-width: 2',
        '}',
        'a -> b: "1"',
        'grid-columns: 3',
      ].join('\n');

      expect(countNodes(src)).toBe(2);
    });

    it('scores a two-box flow below the drawing threshold', () => {
      // The reference report shipped a two-box "Authentication Flow". Two boxes
      // and an arrow is the absence of a finding, not a small one.
      expect(
        countNodes(builder.securityFlow({ auth_flow_steps: ['login', 'redirect'] })),
      ).toBe(2);
    });
  });

  describe('systemFlow', () => {
    const chain = {
      name: 'analyze',
      entryFile: 'apps/api-gateway/src/jobs/analyze.controller.ts',
      steps: [
        {
          symbol: 'analyze',
          file: 'apps/api-gateway/src/jobs/analyze.controller.ts',
          line: 26,
        },
        {
          symbol: 'createAnalysisJob',
          file: 'apps/api-gateway/src/jobs/jobs.service.ts',
          line: 103,
        },
        { symbol: 'emit', file: 'libs/common/src/rabbitmq/client.ts', line: 8 },
      ],
    };

    it('draws the measured path and the packages it reaches', () => {
      const src = builder.systemFlow(
        [chain],
        [
          { module: 'libs', package: 'amqplib', count: 4 },
          { module: 'web', package: 'react', count: 90 },
        ],
      );

      expect(src).toContain('apps › analyze');
      expect(src).toContain('libs › emit');
      // Scoped to the modules this path touches — `web` is not on it.
      expect(src).toContain('amqplib');
      expect(src).not.toContain('react');
    });

    it('degrades rather than drawing a path it did not measure', () => {
      expect(builder.systemFlow([], [])).toContain(
        'No end-to-end call path measured',
      );
    });
  });

  describe('sequenceFromChain', () => {
    it('keeps same-named symbols in different files apart', () => {
      // Merging them would draw a self-call that is not in the code.
      const src = builder.sequenceFromChain({
        name: 'handle',
        entryFile: 'a/x.ts',
        steps: [
          { symbol: 'handle', file: 'a/x.ts', line: 1 },
          { symbol: 'handle', file: 'b/y.ts', line: 2 },
          { symbol: 'save', file: 'b/y.ts', line: 9 },
        ],
      });

      expect(src).toContain('shape: sequence_diagram');
      expect(countNodes(src)).toBe(3);
    });
  });

  describe('dependencyGraph with measured imports', () => {
    it('draws real module -> package edges instead of an edgeless grid', () => {
      const src = builder.dependencyGraph(
        { runtime_dependencies: ['react'], critical_deps: ['react'] },
        [
          { module: 'components', package: 'react', count: 37 },
          { module: 'lib', package: 'zod', count: 3 },
        ],
      );

      expect(src).toContain('-> ');
      expect(src).toContain('"37"');
      expect(src).toContain('[CRITICAL] react');
    });

    it('never leaves a package node without an edge into a drawn module', () => {
      const src = builder.dependencyGraph({}, [
        { module: 'a', package: 'p1', count: 5 },
        { module: 'b', package: 'p2', count: 1 },
      ]);

      // Two modules, two packages, two edges — nothing floating.
      expect(countNodes(src)).toBe(4);
      expect((src.match(/->/g) ?? []).length).toBe(2);
    });
  });
});
