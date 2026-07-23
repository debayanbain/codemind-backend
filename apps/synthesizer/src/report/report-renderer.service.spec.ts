import { ReportRenderer } from './report-renderer.service';
import type { RenderedDiagram, RepoFacts } from '@app/common';

const diagram = (slug: string): RenderedDiagram =>
  ({
    slug,
    title: slug,
    kind: 'd2',
    source: `# ${slug}`,
    svg: '<svg/>',
    degraded: false,
  }) as unknown as RenderedDiagram;

const DIAGRAMS = [
  'health-gauge',
  'architecture-modules',
  'security-auth-flow',
  'dependency-graph',
  'quality-donut',
].map(diagram);

const facts = (over: Partial<RepoFacts> = {}): RepoFacts => ({
  runKey: 'j-0',
  stats: {
    files: 81,
    nodes: 849,
    edges: 1466,
    linesOfCode: 6287,
    sizeBytes: 1,
  },
  languages: [{ language: 'typescript', files: 81 }],
  dominantLanguage: 'typescript',
  frameworks: ['nestjs'],
  routes: [
    {
      url: 'GET /health',
      handler: 'HealthController.check',
      file: 'apps/api-gateway/src/health.controller.ts',
      line: 12,
      kind: 'method',
    },
  ],
  totalRoutes: 23,
  modules: [
    {
      name: 'apps',
      files: 60,
      linesOfCode: 5000,
      sampleFiles: ['apps/a.ts'],
      exports: ['AppModule'],
    },
    {
      name: 'libs',
      files: 21,
      linesOfCode: 1287,
      sampleFiles: ['libs/b.ts'],
      exports: ['PrismaService'],
    },
  ],
  moduleDependencies: [{ from: 'apps', to: 'libs', weight: 12 }],
  complexityHotspots: [
    {
      symbol: 'handle',
      file: 'apps/agent-worker/src/jobs/agent.consumer.ts',
      line: 123,
      callers: 5,
      callees: 9,
      depth: 3,
    },
  ],
  circularDependencies: [['a.ts', 'b.ts', 'a.ts']],
  deadCode: [
    { symbol: 'unused', file: 'libs/x.ts', line: 4, kind: 'function' },
  ],
  degraded: [],
  ...over,
});

const input = (over: Record<string, unknown> = {}) => ({
  jobId: 'j',
  agentOutputs: {
    architecture: {
      summary: 'A message-driven pipeline.',
      module_responsibilities: [
        { module: 'apps', responsibility: 'The four deployables.' },
      ],
    },
    quality: {},
    security: {},
    dependency: {},
    docs: {},
  },
  diagrams: DIAGRAMS,
  synthesis: {
    executiveSummary: 'Solid.',
    recommendations: ['Do the thing'],
    overallHealthScore: 78,
  },
  totalTokens: 120_000,
  facts: facts(),
  ...over,
});

describe('ReportRenderer', () => {
  const renderer = new ReportRenderer();

  it('opens with measured facts, not model output', () => {
    // A report opens as measured or it opens as vibes. These numbers came from
    // AST parsing and no model ever saw them.
    const md = renderer.render(input());

    expect(md).toContain('At a glance');
    expect(md).toContain('| Files indexed | 81 |');
    expect(md).toContain('Lines of code | 6,287');
    expect(md).toContain('849 / 1,466');
    expect(md).toContain('| Routes | 23 |');
  });

  it('joins the measured module skeleton to the agent’s responsibility', () => {
    const md = renderer.render(input());

    expect(md).toContain('### Modules');
    expect(md).toContain('| `apps` | 60 | 5,000 | The four deployables. |');
    // A module the agent never characterised is marked, not silently blank.
    expect(md).toContain('_not characterised_');
  });

  it('lists real routes with the file:line they are defined at', () => {
    // The section that was impossible before: you cannot write an honest
    // "here's how to call this" from invented endpoints.
    const md = renderer.render(input());

    expect(md).toContain('API surface');
    expect(md).toContain('`GET /health`');
    expect(md).toContain('`apps/api-gateway/src/health.controller.ts:12`');
  });

  it('ranks complexity by measurement and shows the numbers', () => {
    const md = renderer.render(input());

    expect(md).toContain('| `handle` |');
    expect(md).toContain('agent.consumer.ts:123');
  });

  it('reports real cycles and unreferenced symbols', () => {
    const md = renderer.render(input());

    expect(md).toContain('### Circular dependencies');
    expect(md).toContain('### Unreferenced symbols');
    expect(md).toContain('`unused`');
  });

  it('prices with the model that actually ran, not a stale hardcoded rate', () => {
    // The old line applied an input-only rate for a model that wasn't running
    // to input+output combined. A cost figure nobody can trust is worse than
    // none, because this number IS the "I can measure spend" claim.
    //
    // The model is pinned here rather than inherited from .env: a test named
    // "prices with the model that actually ran" that silently reads ambient
    // config is asserting on whatever the developer last configured. It broke
    // the moment the agents moved to Haiku, which is the tell.
    // Pin the provider too: agentModel() now follows AGENT_LLM_PROVIDER (Mistral
    // by default for this build), so pricing the Anthropic path means asserting
    // it explicitly rather than inheriting whatever .env last selected.
    const prevModel = process.env.ANTHROPIC_AGENT_MODEL;
    const prevProvider = process.env.AGENT_LLM_PROVIDER;
    process.env.AGENT_LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_AGENT_MODEL = 'claude-sonnet-4-6';
    try {
      const md = renderer.render(input());

      expect(md).toContain('claude-sonnet-4-6');
      expect(md).not.toContain('Claude Haiku (agents)');
      // 120k × (3×0.85 + 15×0.15)/1e6 = $0.576. The old math gave $0.096 — it
      // applied an input-only rate, for a model that wasn't running, to
      // input+output combined, and so under-reported by ~6x.
      expect(md).toContain('~$0.576');
    } finally {
      process.env.ANTHROPIC_AGENT_MODEL = prevModel;
      process.env.AGENT_LLM_PROVIDER = prevProvider;
    }
  });

  it('prices a Haiku run at Haiku rates', () => {
    // The other half of the same claim: the figure has to move when the model
    // does. Haiku is the Anthropic-provider agent model (CLAUDE.md Section 8).
    const prevModel = process.env.ANTHROPIC_AGENT_MODEL;
    const prevProvider = process.env.AGENT_LLM_PROVIDER;
    process.env.AGENT_LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_AGENT_MODEL = 'claude-haiku-4-5';
    try {
      const md = renderer.render(input());

      expect(md).toContain('claude-haiku-4-5');
      // 120k × (1×0.85 + 5×0.15)/1e6 = $0.192 — ~3x cheaper than the Sonnet run.
      expect(md).toContain('~$0.192');
    } finally {
      process.env.ANTHROPIC_AGENT_MODEL = prevModel;
      process.env.AGENT_LLM_PROVIDER = prevProvider;
    }
  });

  it('prices a Mistral agent run at Mistral rates', () => {
    // Agents run on Mistral for this build (synthesis stays Anthropic). The cost
    // has to follow the model that actually ran the agents, not the Anthropic
    // fallback config that is still present in the env.
    const prevProvider = process.env.AGENT_LLM_PROVIDER;
    const prevModel = process.env.MISTRAL_AGENT_MODEL;
    process.env.AGENT_LLM_PROVIDER = 'mistral';
    process.env.MISTRAL_AGENT_MODEL = 'mistral-large-latest';
    try {
      const md = renderer.render(input());

      expect(md).toContain('mistral-large-latest');
      // 120k × (2×0.85 + 6×0.15)/1e6 = $0.312.
      expect(md).toContain('~$0.312');
    } finally {
      process.env.AGENT_LLM_PROVIDER = prevProvider;
      process.env.MISTRAL_AGENT_MODEL = prevModel;
    }
  });

  it('flags a truncated agent instead of passing off a capped analysis as thorough', () => {
    const md = renderer.render(
      input({
        agentOutputs: {
          architecture: { summary: 's', truncated: true },
          security: {},
          dependency: {},
          quality: {},
          docs: {},
        },
      }),
    );

    expect(md).toContain('Depth caveat');
    expect(md).toContain('architecture');
  });

  it('renders without facts rather than throwing', () => {
    // Facts age out of Redis at 24h. An old job must still render — just
    // without the measured sections.
    const md = renderer.render(input({ facts: undefined }));

    expect(md).toContain('Codebase Intelligence Report');
    expect(md).not.toContain('What was measured');
    expect(md).not.toContain('API Surface');
    // Falls back to the agent's module table.
    expect(md).toContain('### Modules');
  });

  it('surfaces a partially-computed fact set instead of implying completeness', () => {
    const md = renderer.render(
      input({
        facts: facts({ degraded: ['routes: showing 40 of 120'] }),
      }),
    );

    expect(md).toContain('**Partial:** routes: showing 40 of 120');
  });

  describe('findings register', () => {
    const withFindings = () =>
      renderer.buildFindings(
        {
          vulnerabilities: [
            {
              type: 'Missing ownership check',
              location: 'apps/api-gateway/src/jobs/export.controller.ts:61',
              severity: 'high',
              description: 'Any authenticated user can export any report.',
            },
            {
              type: 'Recalled CVE',
              location: '',
              severity: 'critical',
              description: 'No location — cannot be checked.',
            },
          ],
        },
        {
          issues: [
            {
              category: 'error_handling',
              location: 'lib/api.ts:94',
              description: 'retryJob swallows fetch errors.',
            },
          ],
        },
        { outdated_risks: [{ package: 'left-pad', reason: 'Unmaintained.' }] },
      );

    it('drops a finding with no location instead of printing an uncheckable claim', () => {
      // An unverifiable row sitting next to verifiable ones lowers the
      // credibility of both — so it goes, and the drop is reported.
      const { findings, unanchored } = withFindings();

      expect(unanchored).toBe(1);
      expect(findings.map((f) => f.title)).not.toContain('Recalled CVE');
    });

    it('assigns stable per-area ids and ranks by severity', () => {
      const { findings } = withFindings();

      expect(findings[0].id).toBe('SEC-01');
      expect(findings[0].severity).toBe('high');
      expect(findings.map((f) => f.id)).toEqual(['SEC-01', 'QUA-01', 'DEP-01']);
    });

    it('renders the register and the drop count', () => {
      const { findings, unanchored } = withFindings();
      const md = renderer.render(
        input({ findings, unanchoredFindings: unanchored }),
      );

      expect(md).toContain('Findings register');
      expect(md).toContain('`SEC-01`');
      expect(md).toContain('export.controller.ts:61');
      expect(md).toContain('1 reported item had no file or symbol attached');
    });
  });

  it('drops a flagged endpoint that is not in the route graph', () => {
    // The reference report published `/api/queries` for a repo that has no such
    // route. The graph is the authority on what exists; the agent's assessment
    // rides along on the real rows and anything unmatched is dropped, counted.
    const md = renderer.render(
      input({
        agentOutputs: {
          architecture: {},
          quality: {},
          dependency: {},
          docs: {},
          security: {
            sensitive_endpoints: [
              {
                path: '/health',
                method: 'GET',
                risk: 'low',
                reason: 'Unauthenticated by design.',
              },
              {
                path: '/api/queries',
                method: 'POST',
                risk: 'medium',
                reason: 'Invented.',
              },
            ],
          },
        },
      }),
    );

    expect(md).toContain('Unauthenticated by design.');
    expect(md).not.toContain('Invented.');
    expect(md).toContain('1 endpoint the security agent flagged does not appear');
  });

  it('prices each half at the model that ran it', () => {
    // The old line charged the whole job at the agent rate, understating any
    // job whose synthesis model is dearer — which is every job by default.
    process.env.AGENT_LLM_PROVIDER = 'anthropic';
    process.env.SYNTHESIS_LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_AGENT_MODEL = 'claude-haiku-4-5-20251001';
    process.env.ANTHROPIC_SYNTHESIS_MODEL = 'claude-sonnet-5';

    const md = renderer.render(
      input({
        totalTokens: 1_100_000,
        agentTokens: 1_000_000,
        synthesisTokens: 100_000,
      }),
    );

    // Haiku 1M (1*.85 + 5*.15 = 1.6) + Sonnet 100k (3*.85 + 15*.15 = 4.8 -> .48)
    expect(md).toContain('$2.080');
    expect(md).toContain('**Agents** `claude-haiku-4-5-20251001`');
    expect(md).toContain('**Synthesis** `claude-sonnet-5`');
  });

  it('renders the per-agent run record', () => {
    const md = renderer.render(
      input({
        agentRuns: [
          {
            agentType: 'architecture',
            status: 'success',
            tokens: 42_000,
            durationMs: 31_500,
          },
          {
            agentType: 'security',
            status: 'failed',
            tokens: 0,
            durationMs: null,
          },
        ],
      }),
    );

    expect(md).toContain('### Run record');
    expect(md).toContain('| architecture | ✅ success | 42,000 | 31.5s |');
    expect(md).toContain('| security | ❌ failed | 0 | — |');
  });

  it('numbers every section and links the contents to it', () => {
    const md = renderer.render(input());

    expect(md).toContain('## Contents');
    expect(md).toContain('1. [At a glance](#1-at-a-glance)');
    expect(md).toContain('## 1. At a glance');
    expect(md).toContain('## 11. Findings register');
  });

  it('escapes pipes and newlines that would otherwise destroy a table', () => {
    // Every cell here is LLM output or a repo's own path. One `|` silently
    // wrecks the table around it.
    const md = renderer.render(
      input({
        agentOutputs: {
          architecture: {
            module_responsibilities: [
              { module: 'apps', responsibility: 'Does a | b\nand c.' },
            ],
          },
          quality: {},
          security: {},
          dependency: {},
          docs: {},
        },
      }),
    );

    expect(md).toContain('Does a \\| b and c.');
  });
});
