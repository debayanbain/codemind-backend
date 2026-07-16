import {
  Spec,
  Validated,
  arr,
  bool,
  enumOf,
  nullable,
  num,
  obj,
  optional,
  str,
} from './schema';
import type {
  ArchitectureOutput,
  DependencyOutput,
  DocsOutput,
  SecurityOutput,
  SonnetSynthesisOutput,
} from '../types/agent-outputs.types';
import type { QualityOutput } from '../types/agent-outputs.types';

/**
 * The one definition of each agent's output shape. Feeds both the `emit_*`
 * tool's `input_schema` and the validator that gates what reaches the database.
 *
 * **What is required, and why it matters.** Before this existed, a malformed
 * reply was recorded as `success: true` with `{raw: "..."}` as its output. Two
 * consequences: the synthesizer's "did every agent fail?" guard could never
 * fire, and `{raw}` was handed to the synthesis call as if it were a real
 * analysis. Fields are required here when the report has no sensible way to
 * render without them.
 *
 * Fields left optional are mostly ones the **code graph** is about to own
 * outright (framework, entry points, module edges, complexity hotspots, routes).
 * Those get deleted from the LLM's schema entirely once the RepoFacts pre-pass
 * lands — a fact the AST already knows is not a fact a model should be invited
 * to guess. They stay optional until then so that removal is a deletion, not a
 * migration.
 */

export const architectureSchema = obj({
  // Graph-owned soon: getDetectedFrameworks / getStats.filesByLanguage.
  framework: optional(str()),
  language: optional(str()),
  architecture_pattern: str(),
  entry_points: optional(arr(str())),
  modules: arr(str()),
  // Graph-owned soon: getFileDependencies aggregated to module level. Until
  // then this draws the module diagram, which is why "diagrams can't
  // hallucinate" is not yet fully true.
  module_dependencies: optional(
    arr(obj({ from: str(), to: str(), label: optional(str()) })),
  ),
  module_responsibilities: arr(obj({ module: str(), responsibility: str() })),
  services: optional(arr(str())),
  request_flows: arr(
    obj({ name: str(), steps: arr(str()), description: optional(str()) }),
  ),
  design_patterns: arr(str()),
  summary: str(),
});

export const securitySchema = obj({
  // Nullable, not optional: "this codebase has no auth" is a finding worth
  // stating. Silence is not.
  auth_mechanism: nullable(str()),
  auth_flow_steps: arr(str()),
  // Graph-owned soon: getRoutingManifest.
  sensitive_endpoints: optional(
    arr(
      obj({
        path: str(),
        method: str(),
        risk: enumOf(['high', 'medium', 'low']),
        reason: str(),
      }),
    ),
  ),
  vulnerabilities: arr(
    obj({
      type: str(),
      location: str(),
      severity: enumOf(['critical', 'high', 'medium', 'low']),
      description: str(),
    }),
  ),
  missing_protections: arr(str()),
  secrets_exposure_risk: bool(),
  summary: str(),
});

export const dependencySchema = obj({
  runtime_dependencies: arr(str()),
  dev_dependencies: optional(arr(str())),
  critical_deps: arr(str()),
  outdated_risks: arr(obj({ package: str(), reason: str() })),
  license_concerns: optional(arr(str())),
  version_conflicts: optional(arr(str())),
  summary: str(),
});

export const qualitySchema = obj({
  error_handling_score: enumOf(['good', 'partial', 'poor']),
  type_safety_score: enumOf(['good', 'partial', 'poor']),
  test_coverage_signal: enumOf(['present', 'minimal', 'absent']),
  issues: arr(
    obj({
      category: enumOf([
        'error_handling',
        'type_safety',
        'duplication',
        'complexity',
        'tests',
      ]),
      location: str(),
      description: str(),
    }),
  ),
  positive_patterns: optional(arr(str())),
  // Graph-owned soon: getNodeMetrics.
  complexity_hotspots: optional(arr(str())),
  summary: str(),
});

export const docsSchema = obj({
  readme_quality: enumOf(['excellent', 'good', 'minimal', 'missing']),
  api_documented: bool(),
  public_exports: optional(arr(str())),
  undocumented_public_apis: optional(arr(str())),
  has_contribution_guide: bool(),
  has_changelog: bool(),
  inline_comment_density: enumOf(['high', 'medium', 'low']),
  doc_score: num(),
  summary: str(),
});

export const synthesisSchema = obj({
  executiveSummary: str(),
  recommendations: arr(str()),
  overallHealthScore: num(),
});

/**
 * Per-agent schema lookup. Keyed by the AgentType values used on the wire.
 * Typed as the hand-written output interfaces (all-optional) so existing
 * per-field guards in the renderer and diagram builders keep working — the
 * validator's job is to reject garbage at the boundary, not to retype the
 * whole read path.
 */
export const AGENT_OUTPUT_SCHEMAS = {
  architecture: architectureSchema as Spec<ArchitectureOutput>,
  security: securitySchema as Spec<SecurityOutput>,
  dependency: dependencySchema as Spec<DependencyOutput>,
  quality: qualitySchema as Spec<QualityOutput>,
  docs: docsSchema as Spec<DocsOutput>,
} as const;

export type AgentSchemaKey = keyof typeof AGENT_OUTPUT_SCHEMAS;

export const synthesisOutputSchema =
  synthesisSchema as Spec<SonnetSynthesisOutput>;

/** Convenience: validate an agent's parsed JSON against its schema. */
export function validateAgentOutput(
  agentType: AgentSchemaKey,
  parsed: unknown,
): Validated<
  | ArchitectureOutput
  | SecurityOutput
  | DependencyOutput
  | QualityOutput
  | DocsOutput
> {
  return AGENT_OUTPUT_SCHEMAS[agentType].validate(parsed, agentType);
}
