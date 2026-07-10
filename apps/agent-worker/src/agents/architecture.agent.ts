import { Injectable } from '@nestjs/common';
import { BaseAgent, AgentContext } from './base.agent';

@Injectable()
export class ArchitectureAgent extends BaseAgent {
  readonly agentType = 'architecture';

  // Architecture drives the whole report's structural picture, so give it more
  // output room than the default extraction agents.
  readonly maxOutputTokens = 2600;

  readonly systemPrompt = `You are a senior software architect producing a codebase architecture map that a new engineer could read to understand how the whole repository is wired together. Respond ONLY with valid JSON. No preamble, no markdown fences, no explanation outside JSON.

Required output schema:
{
  "framework": string,
  "language": string,
  "architecture_pattern": string,
  "entry_points": string[],
  "modules": string[],
  "module_dependencies": [{ "from": string, "to": string, "label"?: string }],
  "module_responsibilities": [{ "module": string, "responsibility": string }],
  "services": string[],
  "request_flows": [{ "name": string, "steps": string[], "description": string }],
  "design_patterns": string[],
  "summary": string
}

CRITICAL — what a "module" is:
- A module is a TOP-LEVEL SOURCE DIRECTORY or a LOGICAL LAYER of the repository — e.g. "api-gateway", "orchestrator", "components", "lib", "pages", "services", "common". Derive them from the directory structure in the File Tree.
- A module is NOT an individual file, React/Vue component, class, or function. Do NOT list leaf names like "ContactModal", "Hero", "loadData".
- Aim for 4-12 modules that together cover the whole repo (full wiring), not a random subset.
- If the repo is flat (few dirs), fall back to logical layers: "Entry / bootstrap", "UI", "State / data", "Utilities", "Config".

module_dependencies:
- Directed edges BETWEEN the module names above (from -> to means "from" imports/depends on "to"). AGGREGATE file-level imports up to the module level and DEDUPLICATE (one edge per module pair).
- label (optional): a short verb for the relationship ("imports", "calls", "renders", "reads"). Max 18 edges.

module_responsibilities: one entry per module, responsibility = one plain-English sentence on what that module does.

entry_points: real entry files/bootstrap points only (e.g. "src/main.ts", "app/page.tsx", "index.ts").

request_flows: the 2-3 most important end-to-end flows a real request/interaction takes. steps = ordered REAL function/method/service names from the code (5-8 steps, from the trigger through to the response/side-effect). description = one sentence on what the flow does. If you cannot identify real flows, return [].

design_patterns: architectural/design patterns actually present (e.g. "Dependency Injection", "Repository", "Event-driven / pub-sub", "CQRS").

summary: 3-6 sentences describing the overall architecture — the layers, how they collaborate, and the notable structural decisions. Concrete, not generic.`;

  buildUserMessage(ctx: AgentContext): string {
    return `Map the architecture of this codebase so a newcomer understands how it is wired together end to end.

## Code Graph Context (entry points, controllers, services, imports)
${ctx.graphContext}

${ctx.fileTree ? `## File Tree (use this to derive top-level directory modules)\n\`\`\`\n${ctx.fileTree}\n\`\`\`` : ''}

Derive the "modules" from the top-level source directories above, then wire them with module_dependencies aggregated from real imports. Capture the main end-to-end request flows using real symbol names.
Return only JSON.`;
  }
}
