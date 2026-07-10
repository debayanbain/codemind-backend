import { Injectable } from '@nestjs/common';
import {
  AgentOutputsByType,
  RenderedDiagram,
  SonnetSynthesisOutput,
} from '@app/common';

interface RenderInput {
  jobId: string;
  agentOutputs: AgentOutputsByType;
  diagrams: RenderedDiagram[];
  synthesis: SonnetSynthesisOutput;
  totalTokens: number;
}

@Injectable()
export class ReportRenderer {
  render(input: RenderInput): string {
    const { agentOutputs: o, diagrams, synthesis: s, totalTokens } = input;
    const d = new DiagramFences(diagrams);
    const arch = o.architecture ?? {};
    const sec = o.security ?? {};
    const dep = o.dependency ?? {};
    const qual = o.quality ?? {};
    const docs = o.docs ?? {};

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
    const estimatedCost = ((totalTokens / 1_000_000) * 0.8).toFixed(4); // Haiku ~$0.80/1M input

    const sections: string[] = [];

    // ─── Header ───────────────────────────────────────────────────────────────
    sections.push(`# 🔍 Codebase Intelligence Report

> **Generated:** ${now} | **Tokens Used:** ${totalTokens.toLocaleString()} | **Estimated Cost:** $${estimatedCost}

---`);

    // ─── Health Score ──────────────────────────────────────────────────────────
    const score = s.overallHealthScore ?? 0;
    const healthEmoji = score >= 80 ? '🟢' : score >= 60 ? '🟡' : '🔴';
    sections.push(`## ${healthEmoji} Overall Health: ${score}/100

${d.fence('health-gauge')}
`);

    // ─── Executive Summary ─────────────────────────────────────────────────────
    sections.push(`## 📋 Executive Summary

${s.executiveSummary}

**Framework:** \`${arch.framework ?? 'Unknown'}\` | **Language:** \`${arch.language ?? 'Unknown'}\` | **Pattern:** \`${arch.architecture_pattern ?? 'Unknown'}\`
`);

    // ─── Architecture ──────────────────────────────────────────────────────────
    sections.push(`## 🏗️ Architecture

${arch.summary ?? ''}

### Module Dependency Graph

${d.fence('architecture-modules')}
`);

    const requestFlows = d.matching(/^request-flow-\d+$/);
    if (requestFlows.length > 0) {
      sections.push(`### Request Flows
`);
      requestFlows.forEach((flow) => {
        sections.push(`#### ${flow.title}

${d.fence(flow.slug)}
`);
      });
    }

    if (designPatterns.length > 0) {
      sections.push(`### Design Patterns Detected

${designPatterns.map((p) => `- ${p}`).join('\n')}
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

    if (complexityHotspots.length > 0) {
      sections.push(`### Complexity Hotspots

${complexityHotspots.map((h) => `- 🔥 \`${h}\``).join('\n')}
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

    // ─── Footer ───────────────────────────────────────────────────────────────
    sections.push(`---

*Generated by CodeMind | Claude Haiku (agents) + Claude Sonnet (synthesis)*
*Token usage logged per agent for cost transparency*`);

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
