/**
 * Shapes of each agent's JSON output, matching the schema documented in that
 * agent's systemPrompt (apps/agent-worker/src/agents/*.agent.ts). All fields
 * optional — the LLM's output is only ever validated by JSON.parse, never
 * schema-checked, so any field can legitimately be missing.
 */

export interface ModuleDependency {
  from: string;
  to: string;
  label?: string;
}

export interface RequestFlow {
  name: string;
  steps: string[];
  /** One-line plain-English description of what the flow accomplishes. */
  description?: string;
}

/** A directory/layer-level module and what it is responsible for. */
export interface ModuleResponsibility {
  module: string;
  responsibility: string;
}

export interface ArchitectureOutput {
  framework?: string;
  language?: string;
  architecture_pattern?: string;
  entry_points?: string[];
  /**
   * Directory/layer-level module names (e.g. `api-gateway`, `components`,
   * `lib`), NOT individual files/components/functions. These are the nodes of
   * the wiring graph.
   */
  modules?: string[];
  /** Import-direction edges BETWEEN the modules above, aggregated to the module level. */
  module_dependencies?: ModuleDependency[];
  /** Per-module one-liner: what each module is responsible for. Drives the module table. */
  module_responsibilities?: ModuleResponsibility[];
  services?: string[];
  request_flows?: RequestFlow[];
  design_patterns?: string[];
  /** Fuller architectural narrative (3-6 sentences). */
  summary?: string;
}

export interface SensitiveEndpoint {
  path: string;
  method: string;
  risk: 'high' | 'medium' | 'low';
  reason: string;
}

export interface Vulnerability {
  type: string;
  location: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
}

export interface SecurityOutput {
  auth_mechanism?: string | null;
  auth_flow_steps?: string[];
  sensitive_endpoints?: SensitiveEndpoint[];
  vulnerabilities?: Vulnerability[];
  missing_protections?: string[];
  secrets_exposure_risk?: boolean;
  summary?: string;
}

export interface OutdatedRisk {
  package: string;
  reason: string;
}

export interface DependencyOutput {
  runtime_dependencies?: string[];
  dev_dependencies?: string[];
  critical_deps?: string[];
  outdated_risks?: OutdatedRisk[];
  license_concerns?: string[];
  version_conflicts?: string[];
  summary?: string;
}

export type QualityCategory =
  'error_handling' | 'type_safety' | 'duplication' | 'complexity' | 'tests';

export interface QualityIssue {
  category: QualityCategory;
  location: string;
  description: string;
}

export interface QualityOutput {
  error_handling_score?: 'good' | 'partial' | 'poor';
  type_safety_score?: 'good' | 'partial' | 'poor';
  test_coverage_signal?: 'present' | 'minimal' | 'absent';
  issues?: QualityIssue[];
  positive_patterns?: string[];
  complexity_hotspots?: string[];
  summary?: string;
}

export interface DocsOutput {
  readme_quality?: 'excellent' | 'good' | 'minimal' | 'missing';
  api_documented?: boolean;
  public_exports?: string[];
  undocumented_public_apis?: string[];
  has_contribution_guide?: boolean;
  has_changelog?: boolean;
  inline_comment_density?: 'high' | 'medium' | 'low';
  doc_score?: number;
  summary?: string;
}

export interface AgentOutputsByType {
  architecture?: ArchitectureOutput;
  security?: SecurityOutput;
  dependency?: DependencyOutput;
  quality?: QualityOutput;
  docs?: DocsOutput;
}

export interface SonnetSynthesisOutput {
  executiveSummary: string;
  recommendations: string[];
  overallHealthScore: number;
}
