import { Injectable } from '@nestjs/common';
import {
  ArchitectureOutput,
  SecurityOutput,
  DependencyOutput,
  QualityOutput,
} from '@app/common';

/**
 * ALL Mermaid diagrams are generated programmatically from agent JSON.
 * No LLM calls here — pure data mapping.
 *
 * This means diagrams reflect ACTUAL code relationships from the CodeGraph,
 * not hallucinated descriptions. That's the core interview talking point.
 */
@Injectable()
export class MermaidBuilder {
  // ─── 1. Module Dependency Graph (from architecture agent) ──────────────────

  moduleGraph(arch: ArchitectureOutput): string {
    const deps: Array<{ from: string; to: string; label?: string }> =
      arch.module_dependencies ?? [];
    const modules: string[] = arch.modules ?? [];
    const entries: string[] = arch.entry_points ?? [];

    if (modules.length === 0 && deps.length === 0) {
      return this.emptyDiagram('Module graph not available');
    }

    const lines = ['graph LR'];

    // Entry points styled distinctly
    entries.slice(0, 3).forEach((ep) => {
      const id = this.nodeId(ep);
      lines.push(`  ${id}["🚀 ${ep}"]`);
      lines.push(`  style ${id} fill:#4CAF50,color:#fff,stroke:#388E3C`);
    });

    // Module nodes
    modules.slice(0, 15).forEach((m) => {
      const id = this.nodeId(m);
      lines.push(`  ${id}["📦 ${m}"]`);
    });

    // Dependency edges
    deps.slice(0, 20).forEach(({ from, to, label }) => {
      const fromId = this.nodeId(from);
      const toId = this.nodeId(to);
      const arrow = label ? `-->|"${label}"|` : '-->';
      lines.push(`  ${fromId} ${arrow} ${toId}`);
    });

    return lines.join('\n');
  }

  // ─── 2. Sequence Diagram (request flows from architecture agent) ────────────

  sequenceDiagram(steps: string[]): string {
    if (!steps || steps.length < 2) {
      return this.emptyDiagram('Request flow not available');
    }

    const lines = ['sequenceDiagram', '  autonumber'];

    // Use only first 8 steps max — deeper than that is unreadable
    const capped = steps.slice(0, 8);

    for (let i = 0; i < capped.length - 1; i++) {
      const from = this.participantName(capped[i]);
      const to = this.participantName(capped[i + 1]);
      lines.push(`  ${from}->>+${to}: `);
    }

    // Return arrow back to start
    const last = this.participantName(capped[capped.length - 1]);
    const first = this.participantName(capped[0]);
    lines.push(`  ${last}-->>-${first}: response`);

    return lines.join('\n');
  }

  // ─── 3. Security Auth Flow (from security agent) ───────────────────────────

  securityFlow(sec: SecurityOutput): string {
    const steps: string[] = sec.auth_flow_steps ?? [];
    const vulns = (sec.vulnerabilities ?? []).filter(
      (v) => v.severity === 'critical' || v.severity === 'high',
    );

    if (steps.length === 0) {
      return this.emptyDiagram('Auth flow not detected');
    }

    const lines = ['flowchart TD'];

    // Auth chain nodes
    steps.forEach((step, i) => {
      const id = `A${i}`;
      const icon = i === 0 ? '🌐' : i === steps.length - 1 ? '✅' : '🔑';
      lines.push(`  ${id}["${icon} ${step}"]`);
      if (i < steps.length - 1) lines.push(`  A${i} --> A${i + 1}`);
    });

    // Vulnerability annotations floating off the chain
    if (vulns.length > 0) {
      lines.push('');
      lines.push('  subgraph vulns["⚠️ High/Critical Issues"]');
      vulns.slice(0, 4).forEach((v, i: number) => {
        const vid = `V${i}`;
        lines.push(`    ${vid}["${v.type} @ ${v.location}"]`);
        lines.push(`    style ${vid} fill:#ef5350,color:#fff,stroke:#c62828`);
      });
      lines.push('  end');
    }

    return lines.join('\n');
  }

  // ─── 4. Dependency Graph (from dependency agent) ───────────────────────────

  dependencyGraph(dep: DependencyOutput): string {
    const runtime: string[] = dep.runtime_dependencies ?? [];
    const critical: string[] = dep.critical_deps ?? [];
    const outdated: string[] = (dep.outdated_risks ?? []).map((r) => r.package);

    if (runtime.length === 0) {
      return this.emptyDiagram('Dependency info not available');
    }

    const lines = ['graph TD'];
    lines.push('  App["🏠 Your App"]');
    lines.push('  style App fill:#1565C0,color:#fff');

    // Cap at 15 deps to keep diagram readable
    runtime.slice(0, 15).forEach((pkg) => {
      const id = this.nodeId(pkg);
      const isCritical = critical.includes(pkg);
      const isOutdated = outdated.includes(pkg);

      let icon = '📦';
      if (isCritical && isOutdated) icon = '🚨';
      else if (isCritical) icon = '⚙️';
      else if (isOutdated) icon = '⚠️';

      lines.push(`  App --> ${id}["${icon} ${pkg}"]`);

      if (isCritical && isOutdated) {
        lines.push(`  style ${id} fill:#ef5350,color:#fff`);
      } else if (isCritical) {
        lines.push(`  style ${id} fill:#ff8f00,color:#fff`);
      } else if (isOutdated) {
        lines.push(`  style ${id} fill:#ffd54f,color:#333`);
      }
    });

    if (runtime.length > 15) {
      lines.push(`  More["... +${runtime.length - 15} more"]`);
      lines.push(`  App --> More`);
      lines.push(`  style More fill:#9e9e9e,color:#fff`);
    }

    return lines.join('\n');
  }

  // ─── 5. Code Quality Pie (from quality agent) ──────────────────────────────

  qualityPie(qual: QualityOutput): string {
    const issues = qual.issues ?? [];

    if (issues.length === 0) {
      return 'pie title Code Quality\n  "No Issues Found ✅" : 100';
    }

    const counts: Record<string, number> = {
      'Error Handling': 0,
      'Type Safety': 0,
      Tests: 0,
      Complexity: 0,
      Duplication: 0,
    };

    const catMap: Record<string, string> = {
      error_handling: 'Error Handling',
      type_safety: 'Type Safety',
      tests: 'Tests',
      complexity: 'Complexity',
      duplication: 'Duplication',
    };

    issues.forEach((issue) => {
      const mapped = catMap[issue.category] ?? 'Error Handling';
      counts[mapped] = (counts[mapped] ?? 0) + 1;
    });

    const lines = ['pie title Technical Debt by Category'];
    Object.entries(counts)
      .filter(([, count]) => count > 0)
      .forEach(([label, count]) => {
        lines.push(`  "${label}" : ${count}`);
      });

    return lines.join('\n');
  }

  // ─── 6. Overall Health Gauge (from synthesizer Sonnet call) ────────────────

  healthGauge(score: number): string {
    // xychart-beta is supported in Mermaid >=10
    const label =
      score >= 80 ? 'Healthy' : score >= 60 ? 'Needs Attention' : 'Critical';

    return `xychart-beta
  title "Overall Health Score: ${score}/100 (${label})"
  x-axis ["Health"]
  y-axis 0 --> 100
  bar [${score}]`;
    // Note: style attribute not available in xychart-beta — color conveys risk via label
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Mermaid node IDs cannot have spaces, dots, slashes, or most special chars.
   * Replace everything except alphanumeric and underscore.
   */
  private nodeId(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  }

  /**
   * Sequence diagram participants can have spaces but strip special chars.
   */
  private participantName(name: string): string {
    return name.replace(/[^a-zA-Z0-9\s]/g, '').trim() || 'Unknown';
  }

  private emptyDiagram(message: string): string {
    return `graph LR\n  N["${message}"]`;
  }
}
