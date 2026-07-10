import { Injectable } from '@nestjs/common';
import { BaseAgent, AgentContext } from './base.agent';

@Injectable()
export class DocsAgent extends BaseAgent {
  readonly agentType = 'docs';

  readonly systemPrompt = `You are a technical writer evaluating documentation quality.
Respond ONLY with valid JSON. No preamble, no markdown fences.

Required output schema:
{
  "readme_quality": "excellent"|"good"|"minimal"|"missing",
  "api_documented": boolean,
  "public_exports": string[],
  "undocumented_public_apis": string[],
  "has_contribution_guide": boolean,
  "has_changelog": boolean,
  "inline_comment_density": "high"|"medium"|"low",
  "doc_score": number,
  "summary": string
}

doc_score: 0-100 overall documentation health score.
public_exports: names of exported functions/classes/modules.
undocumented_public_apis: public exports with no JSDoc/docstring.`;

  buildUserMessage(ctx: AgentContext): string {
    return `Evaluate the documentation coverage of this codebase.

## README Content
${ctx.additionalContext ?? 'README not found'}

## Code Graph Context (public API focus)
${ctx.graphContext}

Return only JSON.`;
  }
}
