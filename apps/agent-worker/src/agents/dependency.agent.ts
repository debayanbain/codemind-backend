import { Injectable } from '@nestjs/common';
import { BaseAgent, AgentContext } from './base.agent';

@Injectable()
export class DependencyAgent extends BaseAgent {
  readonly agentType = 'dependency';

  readonly systemPrompt = `You are a dependency analyst reviewing a project's dependencies.
Respond ONLY with valid JSON. No preamble, no markdown fences.

Required output schema:
{
  "runtime_dependencies": string[],
  "dev_dependencies": string[],
  "critical_deps": string[],
  "outdated_risks": [{ "package": string, "reason": string }],
  "license_concerns": string[],
  "version_conflicts": string[],
  "summary": string
}

critical_deps = dependencies that if removed would break core functionality.
outdated_risks = packages known to have security issues or that are deprecated.
summary: 2-4 sentences on the dependency footprint — the core stack, how many runtime deps, and the notable risks (outdated/at-risk/license). Specific, not generic.`;

  buildUserMessage(ctx: AgentContext): string {
    return `Analyze this project's dependencies.

## Manifest File Content
${ctx.additionalContext ?? 'Not available'}

## Code Graph Context (import/require patterns)
${ctx.graphContext}

Return only JSON.`;
  }
}
