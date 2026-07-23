import { Injectable } from '@nestjs/common';
import {
  AgentOutputsByType,
  RenderedDiagram,
  RepoFacts,
  SonnetSynthesisOutput,
  agentModel,
  synthesisModel,
  estimateCostUsd,
  formatUsd,
} from '@app/common';

/** One agent's run, for the appendix. Straight off the `agent_results` rows. */
export interface AgentRunSummary {
  agentType: string;
  status: string;
  tokens: number;
  durationMs: number | null;
  error?: string | null;
}

interface RenderInput {
  jobId: string;
  agentOutputs: AgentOutputsByType;
  diagrams: RenderedDiagram[];
  synthesis: SonnetSynthesisOutput;
  totalTokens: number;
  /**
   * Split out so each half is priced at the model that actually ran it. Omit
   * both and the whole job is priced at the agent model, which is what this did
   * before and understates any job whose synthesis model is dearer.
   */
  agentTokens?: number;
  synthesisTokens?: number;
  /** Per-agent run record. Already in Postgres; never previously rendered. */
  agentRuns?: AgentRunSummary[];
  /**
   * The findings register, built *before* synthesis and passed to both, so the
   * ids the recommendations cite are the ids the register actually assigns.
   */
  findings?: Finding[];
  /** Reported items dropped for having no checkable location. */
  unanchoredFindings?: number;
  /** AST ground truth. Absent only if the run's facts aged out of Redis. */
  facts?: RepoFacts;
}

/**
 * One row of the findings register.
 *
 * The register exists because the report used to state the same problem in three
 * places and connect none of them: a vulnerability under Security, an issue
 * under Quality, a package under Dependencies, and then five recommendations
 * that referred to none of them by name. Giving every finding a stable id lets
 * the recommendations cite it, which is the difference between a list of
 * observations and an assessment.
 */
export interface Finding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  area: string;
  title: string;
  location: string | null;
  detail: string;
}

const SEVERITY_RANK: Record<Finding['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Sections, numbered once so the Markdown, the PDF and the nav can't drift. */
const SECTIONS = [
  'At a glance',
  'Executive summary',
  'How it runs',
  'System flow',
  'Architecture',
  'API surface',
  'Security',
  'Dependencies',
  'Code quality',
  'Documentation',
  'Findings register',
  'Recommendations',
  'Appendix: how this was produced',
] as const;

/** `## 5. Architecture` — numbers derive from SECTIONS, never hand-written. */
function heading(name: (typeof SECTIONS)[number]): string {
  return `## ${SECTIONS.indexOf(name) + 1}. ${name}`;
}

/** The slug GitHub/most Markdown renderers generate for that heading. */
function anchor(n: number, name: string): string {
  return `${n}-${name
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-')}`;
}

/**
 * Compare two route strings written by different sources. The graph reports
 * `GET /jobs/:id`; an agent writes `/jobs/:jobId`. Same endpoint, and matching
 * them literally would flag every route as unverified.
 */
function normalizeRoute(url: string): string {
  return String(url ?? '')
    .replace(/^[A-Z]+\s+/, '')
    .replace(/:[^/]+/g, ':p')
    .replace(/\/+$/, '')
    .toLowerCase();
}

@Injectable()
export class ReportRenderer {
  render(input: RenderInput): string {
    const {
      agentOutputs: o,
      diagrams,
      synthesis: s,
      totalTokens,
      agentTokens = totalTokens,
      synthesisTokens = 0,
      agentRuns = [],
      findings = [],
      unanchoredFindings: unanchored = 0,
      facts: rawFacts,
    } = input;

    // `facts` is JSON read back from Redis, and a job whose orchestrator ran an
    // older build has none of the fields added since. Fill them in once here
    // rather than guarding at forty interpolation sites — a missing array must
    // render as "—", never throw and cost the whole report.
    const facts = rawFacts
      ? ({
          ...rawFacts,
          callChains: rawFacts.callChains ?? [],
          externalImports: rawFacts.externalImports ?? [],
          dependencies: rawFacts.dependencies ?? [],
          entryPoints: rawFacts.entryPoints ?? [],
          largestFiles: rawFacts.largestFiles ?? [],
          languages: rawFacts.languages ?? [],
          modules: rawFacts.modules ?? [],
          moduleDependencies: rawFacts.moduleDependencies ?? [],
          complexityHotspots: rawFacts.complexityHotspots ?? [],
          circularDependencies: rawFacts.circularDependencies ?? [],
          deadCode: rawFacts.deadCode ?? [],
          routes: rawFacts.routes ?? [],
          frameworks: rawFacts.frameworks ?? [],
          degraded: rawFacts.degraded ?? [],
        } satisfies RepoFacts)
      : undefined;
    const d = new DiagramFences(diagrams);
    const arch = o.architecture ?? {};
    const sec = o.security ?? {};
    const dep = o.dependency ?? {};
    const qual = o.quality ?? {};
    const docs = o.docs ?? {};

    const moduleResponsibilities = arch.module_responsibilities ?? [];
    const requestFlowMeta = arch.request_flows ?? [];
    const designPatterns = arch.design_patterns ?? [];
    const vulnerabilities = sec.vulnerabilities ?? [];
    const missingProtections = sec.missing_protections ?? [];
    const outdatedRisks = dep.outdated_risks ?? [];
    const licenseConcerns = dep.license_concerns ?? [];
    const complexityHotspots = qual.complexity_hotspots ?? [];
    const positivePatterns = qual.positive_patterns ?? [];
    const qualityIssues = qual.issues ?? [];
    const undocumentedApis = docs.undocumented_public_apis ?? [];
    const recommendations = s.recommendations ?? [];

    const now = new Date().toISOString().split('T')[0];
    const model = agentModel();
    const synthModel = synthesisModel();

    // Priced per model that actually ran, not per agent model applied to
    // everything. The old line charged the Sonnet-class synthesis call at the
    // agent rate, which understated a job by however far apart the two are.
    // Shared with the API's ReportPayload — see libs/common/src/llm/pricing.ts.
    const costUsd =
      estimateCostUsd(agentTokens, model) +
      estimateCostUsd(synthesisTokens, synthModel);
    const estimatedCost = formatUsd(costUsd);

    const sections: string[] = [];

    // ─── Header ───────────────────────────────────────────────────────────────
    sections.push(`# Codebase Intelligence Report

> **Generated** ${now} · **Agents** \`${model}\` · **Synthesis** \`${synthModel}\` · **Tokens** ${totalTokens.toLocaleString()} · **Est. cost** ~${estimatedCost}

---`);

    // ─── Contents ─────────────────────────────────────────────────────────────
    // Numbered once, here, and every heading below derives its number from the
    // same list — so the Markdown, the PDF and the dashboard nav cannot drift
    // apart the way three hand-maintained orderings always do.
    sections.push(`## Contents

${SECTIONS.map((name, i) => `${i + 1}. [${name}](#${anchor(i + 1, name)})`).join('\n')}

---`);

    // ─── 1. At a glance ───────────────────────────────────────────────────────
    // Everything a reader needs to decide whether to keep reading, on one
    // screen, with the measured half clearly separated from the judged half.
    const score = s.overallHealthScore ?? 0;
    const bySeverity = (level: Finding['severity']): number =>
      findings.filter((f) => f.severity === level).length;

    sections.push(`${heading('At a glance')}

${d.fence('health-gauge')}

| | Measured | | Assessed |
|---|---|---|---|
| Files indexed | ${facts ? facts.stats.files.toLocaleString() : '—'} | Health score | **${score}/100** |
| Lines of code | ${facts ? facts.stats.linesOfCode.toLocaleString() : '—'} | Critical + high findings | **${bySeverity('critical') + bySeverity('high')}** |
| Graph nodes / edges | ${facts ? `${facts.stats.nodes.toLocaleString()} / ${facts.stats.edges.toLocaleString()}` : '—'} | Medium findings | ${bySeverity('medium')} |
| Routes | ${facts ? facts.totalRoutes : '—'} | Low findings | ${bySeverity('low')} |
| Modules | ${facts ? facts.modules.length : '—'} | Error handling | ${this.scoreBadge(qual.error_handling_score)} |
| Test files | ${facts ? facts.testFiles : '—'} | Type safety | ${this.scoreBadge(qual.type_safety_score)} |
| Doc files | ${facts ? facts.docFiles : '—'} | Test coverage signal | ${this.scoreBadge(qual.test_coverage_signal)} |
| Declared dependencies | ${facts ? facts.dependencies.length : '—'} | Documentation | ${docs.doc_score ?? 'N/A'}/100 |
| Import cycles | ${facts ? facts.circularDependencies.length : '—'} | Auth mechanism | \`${this.cell(sec.auth_mechanism ?? 'none detected')}\` |

**Stack:** \`${this.cell(facts?.frameworks[0] ?? arch.framework ?? 'Unknown')}\` · \`${this.cell(facts?.dominantLanguage ?? arch.language ?? 'Unknown')}\` · \`${this.cell(arch.architecture_pattern ?? 'Unknown')}\`${
      facts?.languages.length
        ? `\n**Languages:** ${facts.languages
            .slice(0, 5)
            .map((l) => `${l.language} (${l.files})`)
            .join(' · ')}`
        : ''
    }

*The left column is AST output — no model produced any of it, so none of it can
be wrong in the way a model can be wrong. The right column is judgment, and every
row of it is traceable to a finding in section ${SECTIONS.indexOf('Findings register') + 1}.*${
      facts?.degraded.length
        ? `\n\n> **Partial:** ${this.cell(facts.degraded.join('; '))}.`
        : ''
    }
`);

    // ─── 2. Executive summary ─────────────────────────────────────────────────
    sections.push(`${heading('Executive summary')}

${s.executiveSummary}
`);

    // ─── 3. How it runs ───────────────────────────────────────────────────────
    // The first question anyone handed a repo asks, and the report has never
    // answered it. Every row is read out of the manifest or the graph.
    if (facts?.entryPoints.length) {
      const commands = facts.entryPoints.filter(
        (e) => e.kind === 'script' || e.kind === 'bin' || e.kind === 'main',
      );
      const symbols = facts.entryPoints.filter(
        (e) => e.kind === 'route' || e.kind === 'component',
      );

      sections.push(`${heading('How it runs')}
${
  commands.length
    ? `
| Command | Runs |
|---|---|
${commands.map((e) => `| \`${this.cell(e.name)}\` | \`${this.cell(e.detail)}\` |`).join('\n')}
`
    : ''
}${
        symbols.length
          ? `
Where execution enters the code:

${symbols.map((e) => `- \`${this.cell(e.name)}\` — \`${this.cell(e.detail)}\``).join('\n')}
`
          : ''
      }`);
    }

    // ─── 4. System flow ───────────────────────────────────────────────────────
    const systemFlow = d.get('system-flow');
    if (systemFlow && facts?.callChains.length) {
      const chain = [...facts.callChains].sort(
        (a, b) => b.steps.length - a.steps.length,
      )[0];
      sections.push(`${heading('System flow')}

One real path through the system, end to end. Every arrow is a \`calls\` edge in
the graph — this is a trace, not a summary.

${d.fence('system-flow')}

| # | Symbol | Defined at |
|---:|---|---|
${chain.steps
  .map(
    (step, i) =>
      `| ${i + 1} | \`${this.cell(step.symbol)}\` | \`${this.cell(step.file)}:${step.line}\` |`,
  )
  .join('\n')}
`);
    }

    // ─── 5. Architecture ──────────────────────────────────────────────────────
    sections.push(`${heading('Architecture')}

${arch.summary ?? ''}

### Module dependency graph

${d.fence('architecture-modules')}
`);

    // Per-module deep dive: the measured skeleton (files, LOC, exports, real
    // internal edges, the hotspots that actually live in it) joined to the
    // agent's one-line responsibility. Neither half is worth much alone — the
    // numbers don't say what a module is FOR, and the prose is unanchored
    // without them.
    const responsibilityOf = new Map(
      moduleResponsibilities.map((m) => [m.module, m.responsibility]),
    );
    if (facts?.modules.length) {
      sections.push(`### Modules

| Module | Files | LOC | Responsibility |
|---|---:|---:|---|
${facts.modules
  .map(
    (m) =>
      `| \`${this.cell(m.name)}\` | ${m.files} | ${m.linesOfCode.toLocaleString()} | ${
        this.cell(responsibilityOf.get(m.name)) || '_not characterised_'
      } |`,
  )
  .join('\n')}
`);

      for (const m of facts.modules) {
        const dependsOn = facts.moduleDependencies.filter(
          (e) => e.from === m.name,
        );
        const dependedOnBy = facts.moduleDependencies.filter(
          (e) => e.to === m.name,
        );
        const hotspots = facts.complexityHotspots.filter((h) =>
          h.file.startsWith(`${m.name}/`),
        );
        const packages = facts.externalImports
          .filter((e) => e.module === m.name)
          .slice(0, 6);

        sections.push(`#### \`${this.cell(m.name)}\`

${this.cell(responsibilityOf.get(m.name)) || '_The architecture agent did not characterise this module._'}

- **Size** — ${m.files} file${m.files === 1 ? '' : 's'}, ${m.linesOfCode.toLocaleString()} lines
- **Files** — ${m.sampleFiles
          .slice(0, 4)
          .map((f) => `\`${f}\``)
          .join(', ')}${m.files > 4 ? `, +${m.files - 4} more` : ''}
- **Public surface** — ${
          m.exports.length
            ? m.exports.map((e) => `\`${this.cell(e)}\``).join(', ')
            : '_none exported_'
        }
- **Imports from** — ${
          dependsOn.length
            ? dependsOn
                .map((e) => `\`${e.to}\` (${e.weight})`)
                .join(', ')
            : '_nothing in this repo_'
        }
- **Imported by** — ${
          dependedOnBy.length
            ? dependedOnBy
                .map((e) => `\`${e.from}\` (${e.weight})`)
                .join(', ')
            : '_nothing in this repo_'
        }${
          packages.length
            ? `\n- **Third-party** — ${packages
                .map((p) => `\`${p.package}\` (${p.count})`)
                .join(', ')}`
            : ''
        }${
          hotspots.length
            ? `\n- **Hotspots here** — ${hotspots
                .map((h) => `\`${h.symbol}\` (${h.callers}↤ ${h.callees}↦)`)
                .join(', ')}`
            : ''
        }
`);
      }
    } else if (moduleResponsibilities.length > 0) {
      sections.push(`### Modules

| Module | Responsibility |
|--------|----------------|
${moduleResponsibilities
  .map((m) => `| \`${this.cell(m.module)}\` | ${this.cell(m.responsibility)} |`)
  .join('\n')}
`);
    }

    if (facts?.circularDependencies.length) {
      sections.push(`### Circular dependencies

Real cycles found in the import graph, not suspected ones:

${facts.circularDependencies
  .map((c) => `- ${c.map((f) => `\`${this.cell(f)}\``).join(' → ')}`)
  .join('\n')}
`);
    }

    const requestFlows = d.matching(/^request-flow-\d+$/);
    if (requestFlows.length > 0) {
      sections.push(`### Request flows
`);
      requestFlows.forEach((flow, i) => {
        const description = requestFlowMeta[i]?.description;
        sections.push(`#### ${this.cell(flow.title)}
${description ? `\n${description}\n` : ''}
${d.fence(flow.slug)}
`);
      });
    }

    if (designPatterns.length > 0) {
      sections.push(`### Design patterns detected

${designPatterns.map((p) => `- ${this.cell(p)}`).join('\n')}
`);
    }

    if (facts?.largestFiles.length) {
      sections.push(`### Where the mass is

| File | Lines |
|---|---:|
${facts.largestFiles
  .map((f) => `| \`${this.cell(f.path)}\` | ${f.linesOfCode.toLocaleString()} |`)
  .join('\n')}
`);
    }

    // ─── 6. API surface ───────────────────────────────────────────────────────
    // Enumerated from the code graph's routing manifest, so this is every route
    // that exists rather than the ones a model remembered. The "flagged" column
    // joins the security agent's assessment onto the real route list, instead of
    // letting it publish an endpoint table of its own — which is how the previous
    // report came to list `/api/queries`, a route that does not exist.
    if (facts?.routes.length) {
      const shown = facts.routes.slice(0, 40);
      const flagged = new Map(
        (sec.sensitive_endpoints ?? []).map((e) => [
          normalizeRoute(e.path),
          e,
        ]),
      );
      const matched = new Set<string>();

      sections.push(`${heading('API surface')}

${facts.totalRoutes} route${facts.totalRoutes === 1 ? '' : 's'}, enumerated from the code graph${
        shown.length < facts.totalRoutes
          ? ` (showing the first ${shown.length})`
          : ''
      }.

| Route | Handler | Defined at | Flagged |
|---|---|---|---|
${shown
  .map((r) => {
    const hit = flagged.get(normalizeRoute(r.url));
    if (hit) matched.add(normalizeRoute(r.url));
    return `| \`${this.cell(r.url)}\` | \`${this.cell(r.handler)}\` | \`${this.cell(r.file)}:${r.line}\` | ${
      hit ? `${this.riskBadge(hit.risk)} — ${this.cell(hit.reason)}` : '—'
    } |`;
  })
  .join('\n')}
${
  flagged.size > matched.size
    ? `\n> ${flagged.size - matched.size} endpoint${flagged.size - matched.size === 1 ? '' : 's'} the security agent flagged ${flagged.size - matched.size === 1 ? 'does' : 'do'} not appear in the route graph and ${flagged.size - matched.size === 1 ? 'was' : 'were'} dropped. The graph is the authority on what exists.`
    : ''
}
`);
    } else if ((sec.sensitive_endpoints ?? []).length > 0) {
      // No routing manifest for this stack — the agent's list is all there is,
      // and it is labelled as such rather than presented as enumerated fact.
      sections.push(`${heading('API surface')}

No routing manifest could be extracted for this stack, so the endpoints below are
the security agent's reading of the code rather than an enumeration of the graph.

| Endpoint | Method | Risk | Reason |
|---|---|---|---|
${(sec.sensitive_endpoints ?? [])
  .map(
    (e) =>
      `| \`${this.cell(e.path)}\` | ${this.cell(e.method)} | ${this.riskBadge(e.risk)} | ${this.cell(e.reason)} |`,
  )
  .join('\n')}
`);
    }

    // ─── 7. Security ──────────────────────────────────────────────────────────
    sections.push(`${heading('Security')}

${sec.summary ?? ''}

**Auth mechanism:** \`${this.cell(sec.auth_mechanism ?? 'None detected')}\`${sec.secrets_exposure_risk ? ' · ⚠️ **Secrets exposure risk detected**' : ''}
`);

    // Suppressed when the traced auth chain was too short to draw — see
    // MIN_DIAGRAM_NODES. The steps are still listed, because the list is the
    // finding; it was the two-box picture that was misleading.
    if (d.get('security-auth-flow')) {
      sections.push(`### Authentication flow

${d.fence('security-auth-flow')}
`);
    } else if ((sec.auth_flow_steps ?? []).length > 0) {
      sections.push(`### Authentication flow

Too few steps were traced to draw a flow diagram. What was found:

${(sec.auth_flow_steps ?? []).map((step, i) => `${i + 1}. ${this.cell(step)}`).join('\n')}
`);
    }

    if (vulnerabilities.length > 0) {
      sections.push(`### Vulnerabilities

${vulnerabilities
  .map(
    (v) =>
      `#### ${this.severityIcon(v.severity)} ${this.cell(v.type)}\n- **Location:** \`${this.cell(v.location)}\`\n- **Severity:** ${v.severity}\n- ${v.description}`,
  )
  .join('\n\n')}
`);
    }

    if (missingProtections.length > 0) {
      sections.push(`### Missing protections

${missingProtections.map((p) => `- ❌ ${this.cell(p)}`).join('\n')}
`);
    }

    // ─── 8. Dependencies ──────────────────────────────────────────────────────
    sections.push(`${heading('Dependencies')}

${dep.summary ?? ''}

### Which modules depend on what

> Packages are tagged \`[CRITICAL]\` and/or \`[OUTDATED]\` in their label — the
> colour repeats that, it never carries it alone. Edge labels are import counts.

${d.fence('dependency-graph')}
`);

    // Versions come from the manifest, parsed. The agent used to transcribe the
    // names out of its prompt and drop the versions entirely.
    if (facts?.dependencies.length) {
      const critical = new Set(dep.critical_deps ?? []);
      const outdated = new Map(outdatedRisks.map((r) => [r.package, r.reason]));
      const usage = new Map<string, number>();
      for (const e of facts.externalImports) {
        usage.set(e.package, (usage.get(e.package) ?? 0) + e.count);
      }

      const runtime = facts.dependencies.filter((x) => x.scope === 'runtime');
      const dev = facts.dependencies.filter((x) => x.scope === 'dev');

      sections.push(`### Declared packages

${runtime.length} runtime, ${dev.length} dev — read from the manifest, with the
import counts measured from the code.

| Package | Version | Scope | Imports | Notes |
|---|---|---|---:|---|
${facts.dependencies
  .slice(0, 40)
  .sort((a, b) => (usage.get(b.name) ?? 0) - (usage.get(a.name) ?? 0))
  .map((x) => {
    const tags: string[] = [];
    if (critical.has(x.name)) tags.push('**critical**');
    if (outdated.has(x.name)) tags.push(`⚠️ ${this.cell(outdated.get(x.name))}`);
    const used = usage.get(x.name) ?? 0;
    if (used === 0) tags.push('_no imports found_');
    return `| \`${this.cell(x.name)}\` | \`${this.cell(x.version)}\` | ${x.scope} | ${used} | ${tags.join(' · ') || '—'} |`;
  })
  .join('\n')}
${
  facts.dependencies.length > 40
    ? `\n_+${facts.dependencies.length - 40} more declared packages._`
    : ''
}
`);
    }

    if (licenseConcerns.length > 0) {
      sections.push(`### License concerns

${licenseConcerns.map((c) => `- ⚠️ ${this.cell(c)}`).join('\n')}
`);
    }

    // ─── 9. Code quality ──────────────────────────────────────────────────────
    sections.push(`${heading('Code quality')}

${qual.summary ?? ''}

| Dimension | Score |
|-----------|-------|
| Error handling | ${this.scoreBadge(qual.error_handling_score)} |
| Type safety | ${this.scoreBadge(qual.type_safety_score)} |
| Test coverage signal | ${this.scoreBadge(qual.test_coverage_signal)} |

### Technical debt distribution

${d.fence('quality-donut')}
`);

    // Measured connectivity beats "looks deeply nested". Callers/callees/depth
    // come from getNodeMetrics, so the ranking is a fact and only the commentary
    // is judgment.
    if (facts?.complexityHotspots.length) {
      sections.push(`### Complexity hotspots

Ranked by measured connectivity — the symbols that are genuinely expensive to change.

| Symbol | Location | Callers | Calls | Depth |
|---|---|---:|---:|---:|
${facts.complexityHotspots
  .map(
    (h) =>
      `| \`${this.cell(h.symbol)}\` | \`${this.cell(h.file)}:${h.line}\` | ${h.callers} | ${h.callees} | ${h.depth} |`,
  )
  .join('\n')}
`);
    } else if (complexityHotspots.length > 0) {
      sections.push(`### Complexity hotspots

${complexityHotspots.map((h) => `- 🔥 \`${this.cell(h)}\``).join('\n')}
`);
    }

    if (facts?.deadCode.length) {
      sections.push(`### Unreferenced symbols

Nothing in the graph calls these. Some will be public API or entry points — the rest is dead.

${facts.deadCode
  .map(
    (dc) =>
      `- \`${this.cell(dc.symbol)}\` (${dc.kind}) — \`${this.cell(dc.file)}:${dc.line}\``,
  )
  .join('\n')}
`);
    }

    if (positivePatterns.length > 0) {
      sections.push(`### What's done well

${positivePatterns.map((p) => `- ✅ ${this.cell(p)}`).join('\n')}
`);
    }

    // ─── 10. Documentation ────────────────────────────────────────────────────
    sections.push(`${heading('Documentation')}

| Item | Status |
|------|--------|
| README | ${this.qualityBadge(docs.readme_quality)} |
| API documentation | ${docs.api_documented ? '✅ Yes' : '❌ No'} |
| Contribution guide | ${docs.has_contribution_guide ? '✅ Yes' : '❌ No'} |
| Changelog | ${docs.has_changelog ? '✅ Yes' : '❌ No'} |
| Inline comments | ${this.cell(docs.inline_comment_density) || 'Unknown'} |
| Doc files in repo | ${facts ? facts.docFiles : '—'} |
| **Doc score** | **${docs.doc_score ?? 'N/A'}/100** |

${docs.summary ?? ''}
`);

    if (undocumentedApis.length > 0) {
      sections.push(`### Undocumented public APIs

${undocumentedApis.map((a) => `- \`${this.cell(a)}\``).join('\n')}
`);
    }

    // ─── 11. Findings register ────────────────────────────────────────────────
    // Every finding the run produced, in one place, ranked, each with an id the
    // recommendations can cite. A finding with no location it can be checked at
    // does not make it in — a claim you can't point at is a claim this report
    // can't make.
    sections.push(`${heading('Findings register')}

${
  findings.length
    ? `Every finding across all agents, ranked by severity. Each carries the location it was found at, so it can be checked.

| ID | Severity | Area | Finding | Location |
|---|---|---|---|---|
${findings
  .map(
    (f) =>
      `| \`${f.id}\` | ${this.severityIcon(f.severity)} ${f.severity} | ${f.area} | ${this.cell(f.title)} | \`${this.cell(f.location)}\` |`,
  )
  .join('\n')}

${findings
  .map((f) => `**\`${f.id}\`** — ${f.detail}`)
  .join('\n\n')}`
    : 'No findings were reported with a location that could be verified.'
}${
      unanchored > 0
        ? `\n\n> ${unanchored} reported item${unanchored === 1 ? '' : 's'} had no file or symbol attached and ${unanchored === 1 ? 'was' : 'were'} dropped from this register.`
        : ''
    }
`);

    // ─── 12. Recommendations ──────────────────────────────────────────────────
    if (recommendations.length > 0) {
      sections.push(`${heading('Recommendations')}

${recommendations.map((r, i) => `${i + 1}. ${r}`).join('\n')}
`);
    }

    // ─── 13. Appendix ─────────────────────────────────────────────────────────
    // Method, stated plainly. A reader deciding how much to trust a finding
    // needs to know which parts were measured and which were judged — and any
    // agent that hit its cap produced a narrower analysis, which is the reader's
    // business, not something to quietly absorb.
    const truncated = (
      ['architecture', 'security', 'dependency', 'quality', 'docs'] as const
    ).filter((k) => (o[k] as { truncated?: boolean } | undefined)?.truncated);

    sections.push(`---

${heading('Appendix: how this was produced')}

Structure, routes, module edges, dependency versions, complexity, cycles and the
call chains in section ${SECTIONS.indexOf('System flow') + 1} were extracted by AST parsing — no model was involved, so
they are measured rather than recalled. The judgment on top of them came from
agents reading the actual code through a bounded tool loop over the code graph,
each ending in a schema-validated result. Diagrams are built from that structured
data by plain TypeScript and rendered server-side; a model never writes diagram
syntax, and a diagram with too few nodes to be meaningful is dropped rather than
drawn.

### Run record

| Agent | Status | Tokens | Duration |
|---|---|---:|---:|
${agentRuns
  .map(
    (r) =>
      `| ${r.agentType} | ${r.status === 'success' ? '✅ success' : `❌ ${this.cell(r.status)}`} | ${r.tokens.toLocaleString()} | ${r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'} |`,
  )
  .join('\n')}
| _synthesis_ | ✅ success | ${synthesisTokens.toLocaleString()} | — |
| **total** | | **${totalTokens.toLocaleString()}** | |

Agents ran on \`${model}\`, synthesis on \`${synthModel}\`; each half is priced at its
own rate, giving ~${estimatedCost}. These figures come from the \`agent_results\`
rows — the cost is queryable, not asserted.
${
  truncated.length
    ? `\n> **Depth caveat:** the ${truncated.join(', ')} ${
        truncated.length === 1 ? 'agent' : 'agents'
      } hit a turn or token cap and finished early. Those sections are narrower than the rest.`
    : ''
}
*Generated by CodeMind.*`);

    return sections.join('\n');
  }

  /**
   * Collapse every agent's findings into one ranked register.
   *
   * The drop rule is the load-bearing part: a finding with no file, symbol or
   * package attached cannot be checked, and an unverifiable row sitting next to
   * verifiable ones lowers the credibility of both. Dropped rows are counted and
   * reported rather than silently discarded.
   */
  buildFindings(
    sec: AgentOutputsByType['security'] = {},
    qual: AgentOutputsByType['quality'] = {},
    dep: AgentOutputsByType['dependency'] = {},
  ): { findings: Finding[]; unanchored: number } {
    const findings: Finding[] = [];
    let unanchored = 0;

    const loc = (raw: string | undefined | null): string | null => {
      const trimmed = String(raw ?? '').trim();
      return trimmed && trimmed.toLowerCase() !== 'unknown' ? trimmed : null;
    };

    (sec.vulnerabilities ?? []).forEach((v) => {
      const location = loc(v.location);
      if (!location) {
        unanchored++;
        return;
      }
      findings.push({
        id: `SEC-${String(findings.filter((f) => f.id.startsWith('SEC')).length + 1).padStart(2, '0')}`,
        severity: v.severity,
        area: 'Security',
        title: v.type,
        location,
        detail: v.description,
      });
    });

    (qual.issues ?? []).forEach((issue) => {
      const location = loc(issue.location);
      if (!location) {
        unanchored++;
        return;
      }
      findings.push({
        id: `QUA-${String(findings.filter((f) => f.id.startsWith('QUA')).length + 1).padStart(2, '0')}`,
        // The quality agent grades nothing, so severity is derived from what the
        // category costs: a swallowed error bites in production, a duplicated
        // helper bites a maintainer.
        severity:
          issue.category === 'error_handling' || issue.category === 'tests'
            ? 'medium'
            : 'low',
        area: 'Quality',
        title: issue.category.replace(/_/g, ' '),
        location,
        detail: issue.description,
      });
    });

    (dep.outdated_risks ?? []).forEach((risk) => {
      const location = loc(risk.package);
      if (!location) {
        unanchored++;
        return;
      }
      findings.push({
        id: `DEP-${String(findings.filter((f) => f.id.startsWith('DEP')).length + 1).padStart(2, '0')}`,
        severity: 'medium',
        area: 'Dependencies',
        title: 'At-risk package',
        location,
        detail: risk.reason,
      });
    });

    findings.sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
    return { findings, unanchored };
  }

  /**
   * Make a value safe to drop into a Markdown table cell.
   *
   * Everything here originates in LLM output or a repository's own file paths,
   * either of which can contain a `|` or a newline — both of which silently
   * destroy the table around them. Stripping the raw HTML angle brackets matters
   * too: this Markdown is handed to `md-to-pdf`, which renders it as HTML.
   */
  private cell(value: string | number | undefined | null): string {
    if (value === undefined || value === null) return '';
    return String(value)
      .replace(/[\r\n]+/g, ' ')
      .replace(/\|/g, '\\|')
      .replace(/[<>]/g, '')
      .trim();
  }

  // ─── Formatting helpers ────────────────────────────────────────────────────

  private riskBadge(risk: string): string {
    const labels: Record<string, string> = {
      high: '🔴 High',
      medium: '🟡 Medium',
      low: '🟢 Low',
    };
    return labels[risk] ?? risk;
  }

  private severityIcon(severity: string): string {
    const icons: Record<string, string> = {
      critical: '🚨',
      high: '🔴',
      medium: '🟡',
      low: '🔵',
    };
    return icons[severity] ?? '⚪';
  }

  private scoreBadge(score: string | undefined): string {
    const labels: Record<string, string> = {
      good: '🟢 Good',
      partial: '🟡 Partial',
      poor: '🔴 Poor',
      present: '🟢 Present',
      minimal: '🟡 Minimal',
      absent: '🔴 Absent',
    };
    return (score && labels[score]) ?? score ?? 'Unknown';
  }

  private qualityBadge(quality: string | undefined): string {
    const labels: Record<string, string> = {
      excellent: '🟢 Excellent',
      good: '🟢 Good',
      minimal: '🟡 Minimal',
      missing: '🔴 Missing',
    };
    return (quality && labels[quality]) ?? quality ?? 'Unknown';
  }
}

/**
 * Emits a diagram as a fenced block carrying its *source*, tagged with its slug:
 *
 * ```d2 architecture-modules
 * direction: right
 * m_api -> m_db
 * ```
 *
 * The rendered SVG is not embedded in the Markdown. It's persisted alongside it
 * and spliced in by `inlineDiagrams()` for HTML and PDF. Two reasons: a `.md`
 * export stays a text document a human can read and diff (a 20KB base64 SVG
 * blob is neither), and the source stays authoritative, so restyling every
 * diagram never means re-running the agents.
 */
class DiagramFences {
  private readonly bySlug: Map<string, RenderedDiagram>;

  constructor(private readonly diagrams: RenderedDiagram[]) {
    this.bySlug = new Map(diagrams.map((d) => [d.slug, d]));
  }

  matching(pattern: RegExp): RenderedDiagram[] {
    return this.diagrams.filter((d) => pattern.test(d.slug));
  }

  /**
   * Whether this diagram exists at all. A slug can be absent because the
   * synthesizer suppressed it for having too few nodes to be worth drawing, and
   * the report renders a table in its place rather than a broken reference.
   */
  get(slug: string): RenderedDiagram | undefined {
    return this.bySlug.get(slug);
  }

  fence(slug: string): string {
    const diagram = this.bySlug.get(slug);
    if (!diagram) return `> _Diagram unavailable: ${slug}_`;

    return `\`\`\`${diagram.kind} ${diagram.slug}\n${diagram.source}\n\`\`\``;
  }
}
