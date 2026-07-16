import { Injectable } from '@nestjs/common';
import {
  AgentOutputsByType,
  RenderedDiagram,
  RepoFacts,
  SonnetSynthesisOutput,
  agentModel,
  estimateCostUsd,
  formatUsd,
} from '@app/common';

interface RenderInput {
  jobId: string;
  agentOutputs: AgentOutputsByType;
  diagrams: RenderedDiagram[];
  synthesis: SonnetSynthesisOutput;
  totalTokens: number;
  /** AST ground truth. Absent only if the run's facts aged out of Redis. */
  facts?: RepoFacts;
}

@Injectable()
export class ReportRenderer {
  render(input: RenderInput): string {
    const {
      agentOutputs: o,
      diagrams,
      synthesis: s,
      totalTokens,
      facts,
    } = input;
    const d = new DiagramFences(diagrams);
    const arch = o.architecture ?? {};
    const sec = o.security ?? {};
    const dep = o.dependency ?? {};
    const qual = o.quality ?? {};
    const docs = o.docs ?? {};

    const moduleResponsibilities = arch.module_responsibilities ?? [];
    const requestFlowMeta = arch.request_flows ?? [];
    const designPatterns = arch.design_patterns ?? [];
    const sensitiveEndpoints = sec.sensitive_endpoints ?? [];
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
    // Shared with the API's ReportPayload, so the Markdown and the dashboard
    // cannot disagree about what a job cost — see libs/common/src/llm/pricing.ts.
    const estimatedCost = formatUsd(estimateCostUsd(totalTokens, model));

    const sections: string[] = [];

    // ─── Header ───────────────────────────────────────────────────────────────
    sections.push(`# 🔍 Codebase Intelligence Report

> **Generated:** ${now} · **Model:** \`${model}\` · **Tokens processed:** ${totalTokens.toLocaleString()} · **Est. cost:** ~${estimatedCost}

---`);

    // ─── Measured facts ────────────────────────────────────────────────────────
    // Straight from the AST. No model produced any of these numbers, which is
    // exactly why they lead: a report opens as measured or it opens as vibes.
    if (facts) {
      const langs = facts.languages
        .slice(0, 4)
        .map((l) => `${l.language} (${l.files})`)
        .join(', ');
      sections.push(`## 📐 What was measured

| Metric | Value |
|---|---|
| Files indexed | ${facts.stats.files.toLocaleString()} |
| Lines of code | ${facts.stats.linesOfCode.toLocaleString()} |
| Graph nodes | ${facts.stats.nodes.toLocaleString()} |
| Graph edges | ${facts.stats.edges.toLocaleString()} |
| Routes | ${facts.totalRoutes} |
| Modules | ${facts.modules.length} |
| Languages | ${langs || '—'} |
| Frameworks | ${facts.frameworks.length ? facts.frameworks.join(', ') : 'none detected'} |

*Every figure above comes from AST parsing of the repository — zero LLM involvement, so none of it can be wrong in the way a model can be wrong.*${
        facts.degraded.length
          ? `\n\n> **Partial:** ${facts.degraded.join('; ')}.`
          : ''
      }
`);
    }

    // ─── Health Score ──────────────────────────────────────────────────────────
    const score = s.overallHealthScore ?? 0;
    const healthEmoji = score >= 80 ? '🟢' : score >= 60 ? '🟡' : '🔴';
    sections.push(`## ${healthEmoji} Overall Health: ${score}/100

${d.fence('health-gauge')}
`);

    // ─── Executive Summary ─────────────────────────────────────────────────────
    sections.push(`## 📋 Executive Summary

${s.executiveSummary}

**Framework:** \`${facts?.frameworks[0] ?? arch.framework ?? 'Unknown'}\` | **Language:** \`${facts?.dominantLanguage ?? arch.language ?? 'Unknown'}\` | **Pattern:** \`${arch.architecture_pattern ?? 'Unknown'}\`
`);

    // ─── Architecture ──────────────────────────────────────────────────────────
    sections.push(`## 🏗️ Architecture

${arch.summary ?? ''}

### Module Dependency Graph

${d.fence('architecture-modules')}
`);

    // ─── Component breakdown ───────────────────────────────────────────────────
    // The measured skeleton (files, LOC, exports) joined to the agent's
    // one-line responsibility. Neither half is worth much alone: the numbers
    // don't say what a module is FOR, and the prose is unanchored without them.
    const responsibilityOf = new Map(
      moduleResponsibilities.map((m) => [m.module, m.responsibility]),
    );
    if (facts?.modules.length) {
      sections.push(`### Components

| Module | Files | LOC | Responsibility |
|---|---:|---:|---|
${facts.modules
  .map(
    (m) =>
      `| \`${m.name}\` | ${m.files} | ${m.linesOfCode.toLocaleString()} | ${
        responsibilityOf.get(m.name) ?? '_not characterised_'
      } |`,
  )
  .join('\n')}

${facts.modules
  .filter((m) => m.exports.length)
  .map(
    (m) =>
      `**\`${m.name}\`** — ${m.sampleFiles.slice(0, 4).join(', ')}${
        m.files > 4 ? `, +${m.files - 4} more` : ''
      }\n  Exports: ${m.exports.map((e) => `\`${e}\``).join(', ')}`,
  )
  .join('\n\n')}
`);
    } else if (moduleResponsibilities.length > 0) {
      sections.push(`### Modules

| Module | Responsibility |
|--------|----------------|
${moduleResponsibilities
  .map((m) => `| \`${m.module}\` | ${m.responsibility} |`)
  .join('\n')}
`);
    }

    if (facts?.circularDependencies.length) {
      sections.push(`### Circular Dependencies

These are real cycles found in the import graph, not suspected ones:

${facts.circularDependencies
  .map((c) => `- ${c.map((f) => `\`${f}\``).join(' → ')}`)
  .join('\n')}
`);
    }

    const requestFlows = d.matching(/^request-flow-\d+$/);
    if (requestFlows.length > 0) {
      sections.push(`### Request Flows
`);
      requestFlows.forEach((flow, i) => {
        // request-flow-1 correlates to request_flows[0]; surface its
        // description under the heading when the agent provided one.
        const description = requestFlowMeta[i]?.description;
        sections.push(`#### ${flow.title}
${description ? `\n${description}\n` : ''}
${d.fence(flow.slug)}
`);
      });
    }

    if (designPatterns.length > 0) {
      sections.push(`### Design Patterns Detected

${designPatterns.map((p) => `- ${p}`).join('\n')}
`);
    }

    // ─── API surface ──────────────────────────────────────────────────────────
    // Enumerated from the code graph's routing manifest, so this is every route
    // that exists rather than the ones a model remembered. It's also the section
    // that was impossible before: you cannot write an honest "here is how to call
    // this" from invented endpoints.
    if (facts?.routes.length) {
      const shown = facts.routes.slice(0, 40);
      sections.push(`## 🔌 API Surface

${facts.totalRoutes} route${facts.totalRoutes === 1 ? '' : 's'}, enumerated from the code graph${
        shown.length < facts.totalRoutes
          ? ` (showing the first ${shown.length})`
          : ''
      }.

| Route | Handler | Defined at |
|---|---|---|
${shown
  .map((r) => `| \`${r.url}\` | \`${r.handler}\` | \`${r.file}:${r.line}\` |`)
  .join('\n')}
`);
    }

    // ─── Security ─────────────────────────────────────────────────────────────
    sections.push(`## 🔒 Security Analysis

${sec.summary ?? ''}

**Auth Mechanism:** \`${sec.auth_mechanism ?? 'None detected'}\`${sec.secrets_exposure_risk ? ' | ⚠️ **Secrets exposure risk detected**' : ''}

### Authentication Flow

${d.fence('security-auth-flow')}
`);

    if (sensitiveEndpoints.length > 0) {
      sections.push(`### Sensitive Endpoints

| Endpoint | Method | Risk | Reason |
|----------|--------|------|--------|
${sensitiveEndpoints
  .map(
    (e) =>
      `| \`${e.path}\` | ${e.method} | ${this.riskBadge(e.risk)} | ${e.reason} |`,
  )
  .join('\n')}
`);
    }

    if (vulnerabilities.length > 0) {
      sections.push(`### Vulnerabilities

${vulnerabilities
  .map(
    (v) =>
      `#### ${this.severityIcon(v.severity)} ${v.type}\n- **Location:** \`${v.location}\`\n- **Severity:** ${v.severity}\n- ${v.description}`,
  )
  .join('\n\n')}
`);
    }

    if (missingProtections.length > 0) {
      sections.push(`### Missing Protections

${missingProtections.map((p) => `- ❌ ${p}`).join('\n')}
`);
    }

    // ─── Dependencies ──────────────────────────────────────────────────────────
    sections.push(`## 📦 Dependencies

### Dependency Graph

> Packages are tagged \`[CRITICAL]\` and/or \`[OUTDATED]\` in their label — the
> colour repeats that, it never carries it alone.

${d.fence('dependency-graph')}
`);

    if (outdatedRisks.length > 0) {
      sections.push(`### Outdated / At-Risk Packages

| Package | Reason |
|---------|--------|
${outdatedRisks.map((r) => `| \`${r.package}\` | ${r.reason} |`).join('\n')}
`);
    }

    if (licenseConcerns.length > 0) {
      sections.push(`### License Concerns

${licenseConcerns.map((c) => `- ⚠️ ${c}`).join('\n')}
`);
    }

    // ─── Code Quality ──────────────────────────────────────────────────────────
    sections.push(`## 📊 Code Quality

| Dimension | Score |
|-----------|-------|
| Error Handling | ${this.scoreBadge(qual.error_handling_score)} |
| Type Safety | ${this.scoreBadge(qual.type_safety_score)} |
| Test Coverage Signal | ${this.scoreBadge(qual.test_coverage_signal)} |

### Technical Debt Distribution

${d.fence('quality-donut')}
`);

    // Measured connectivity beats "looks deeply nested". Callers/callees/depth
    // come from getNodeMetrics, so the ranking is a fact and only the commentary
    // is judgment.
    if (facts?.complexityHotspots.length) {
      sections.push(`### Complexity Hotspots

Ranked by measured connectivity — the symbols that are genuinely expensive to change.

| Symbol | Location | Callers | Calls | Depth |
|---|---|---:|---:|---:|
${facts.complexityHotspots
  .map(
    (h) =>
      `| \`${h.symbol}\` | \`${h.file}:${h.line}\` | ${h.callers} | ${h.callees} | ${h.depth} |`,
  )
  .join('\n')}
`);
    } else if (complexityHotspots.length > 0) {
      sections.push(`### Complexity Hotspots

${complexityHotspots.map((h) => `- 🔥 \`${h}\``).join('\n')}
`);
    }

    if (facts?.deadCode.length) {
      sections.push(`### Unreferenced Symbols

Nothing in the graph calls these. Some will be public API or entry points — the rest is dead.

${facts.deadCode
  .map((dc) => `- \`${dc.symbol}\` (${dc.kind}) — \`${dc.file}:${dc.line}\``)
  .join('\n')}
`);
    }

    if (positivePatterns.length > 0) {
      sections.push(`### What's Done Well

${positivePatterns.map((p) => `- ✅ ${p}`).join('\n')}
`);
    }

    if (qualityIssues.length > 0) {
      sections.push(`### Issues Found

${qualityIssues.map((i) => `- **[${i.category}]** \`${i.location}\` — ${i.description}`).join('\n')}
`);
    }

    // ─── Documentation ─────────────────────────────────────────────────────────
    sections.push(`## 📚 Documentation

| Item | Status |
|------|--------|
| README | ${this.qualityBadge(docs.readme_quality)} |
| API Documentation | ${docs.api_documented ? '✅ Yes' : '❌ No'} |
| Contribution Guide | ${docs.has_contribution_guide ? '✅ Yes' : '❌ No'} |
| Changelog | ${docs.has_changelog ? '✅ Yes' : '❌ No'} |
| Inline Comments | ${docs.inline_comment_density ?? 'Unknown'} |
| **Doc Score** | **${docs.doc_score ?? 'N/A'}/100** |

${docs.summary ?? ''}
`);

    if (undocumentedApis.length > 0) {
      sections.push(`### Undocumented Public APIs

${undocumentedApis.map((a) => `- \`${a}\``).join('\n')}
`);
    }

    // ─── Recommendations ───────────────────────────────────────────────────────
    if (recommendations.length > 0) {
      sections.push(`## ✅ Recommendations

${recommendations.map((r, i) => `${i + 1}. ${r}`).join('\n')}
`);
    }

    // ─── How this was produced ────────────────────────────────────────────────
    // Method, stated plainly. A reader deciding how much to trust a finding
    // needs to know which parts were measured and which were judged — and any
    // agent that hit its cap produced a narrower analysis, which is the reader's
    // business, not something to quietly absorb.
    const truncated = (
      ['architecture', 'security', 'dependency', 'quality', 'docs'] as const
    ).filter((k) => (o[k] as { truncated?: boolean } | undefined)?.truncated);

    sections.push(`---

## 🧪 How this report was produced

Structure, routes, module edges, complexity and cycles were extracted by AST
parsing — no model involvement, so they are measured rather than recalled. The
judgment on top of them came from ${
      facts ? facts.modules.length : 'several'
    } modules' worth of agents reading the
actual code through a bounded tool loop over the code graph, each ending in a
schema-validated result. Diagrams are built from that structured data by plain
TypeScript, never written by a model.

${
  truncated.length
    ? `> **Depth caveat:** the ${truncated.join(', ')} ${
        truncated.length === 1 ? 'agent' : 'agents'
      } hit a turn or token cap and finished early. Those sections are narrower than the rest.`
    : ''
}

*Generated by CodeMind · agents + synthesis on \`${model}\` · ${totalTokens.toLocaleString()} tokens processed (~${estimatedCost})*
*Per-agent token usage is recorded in \`agent_results\` — the cost above is queryable, not asserted.*`);

    return sections.join('\n');
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

  fence(slug: string): string {
    const diagram = this.bySlug.get(slug);
    if (!diagram) return `> _Diagram unavailable: ${slug}_`;

    return `\`\`\`${diagram.kind} ${diagram.slug}\n${diagram.source}\n\`\`\``;
  }
}
