import { Injectable } from '@nestjs/common';
import { BaseAgent, AgentContext } from './base.agent';

@Injectable()
export class ArchitectureAgent extends BaseAgent {
  readonly agentType = 'architecture';

  readonly systemPrompt = `You are a senior software architect analyzing a codebase.
Respond ONLY with valid JSON. No preamble, no markdown fences, no explanation outside JSON.

Required output schema:
{
  "framework": string,
  "language": string,
  "architecture_pattern": string,
  "entry_points": string[],
  "modules": string[],
  "module_dependencies": [{ "from": string, "to": string, "label"?: string }],
  "services": string[],
  "request_flows": [{ "name": string, "steps": string[] }],
  "design_patterns": string[],
  "summary": string
}

module_dependencies must be directed edges (from imports to). Max 15 edges.
request_flows: capture the 2 most important user-facing flows. steps = ordered function/service names.
summary: 2 sentences max.`;

  buildUserMessage(ctx: AgentContext): string {
    return `Analyze the architecture of this codebase.

## Code Graph Context
${ctx.graphContext}

${ctx.fileTree ? `## File Tree\n\`\`\`\n${ctx.fileTree}\n\`\`\`` : ''}

Focus: module boundaries, dependency directions, entry points, top request flows.
Return only JSON.`;
  }
}
