import { Injectable } from '@nestjs/common';
import { BaseAgent, AgentContext } from './base.agent';

@Injectable()
export class QualityAgent extends BaseAgent {
  readonly agentType = 'quality';

  readonly systemPrompt = `You are a senior engineer reviewing code quality.
Respond ONLY with valid JSON. No preamble, no markdown fences.

Required output schema:
{
  "error_handling_score": "good"|"partial"|"poor",
  "type_safety_score": "good"|"partial"|"poor",
  "test_coverage_signal": "present"|"minimal"|"absent",
  "issues": [{ "category": "error_handling"|"type_safety"|"duplication"|"complexity"|"tests", "location": string, "description": string }],
  "positive_patterns": string[],
  "complexity_hotspots": string[],
  "summary": string
}

issues: max 10 most important. Focus on patterns, not nitpicks.
complexity_hotspots: file or function names that appear deeply nested or overly complex.`;

  buildUserMessage(ctx: AgentContext): string {
    return `Review the code quality of this codebase.

## Code Graph Context
${ctx.graphContext}

Focus: error handling patterns, type safety, test presence, anti-patterns, complexity.
Return only JSON.`;
  }
}
