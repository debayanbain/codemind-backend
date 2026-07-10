import { D2SourceBuilder } from './d2-source.builder';

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
});
