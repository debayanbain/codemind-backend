import { Injectable } from '@nestjs/common';
import { BaseAgent, AgentContext } from './base.agent';

@Injectable()
export class ArchitectureAgent extends BaseAgent {
  readonly agentType = 'architecture' as const;

  // The structural agent gets the whole structural picture: the module list and
  // the real import edges between them are exactly what it used to invent.
  readonly factSections = [
    'overview',
    'modules',
    'moduleEdges',
    'routes',
    'cycles',
    'entryPoints',
    'callChains',
  ] as const;

  // Architecture drives the whole report's structural picture, so give it more
  // output room than the other agents.
  readonly maxOutputTokens = 5000;

  // It also has genuinely more ground to cover: it walks module by module and
  // traces flows end to end. Eight turns is enough to look at auth; it is not
  // enough to explain a twelve-module system.
  readonly maxTurns = 20;

  readonly rolePrompt = `Your brief: produce the architecture map a new engineer would
read on day one to understand how this repository is wired together end to end.

The Ground Truth already gives you the module list, the real import edges between
them (aggregated from actual imports, with weights), the routes, and any cycles. That
is the skeleton — you do not need to derive it, and you must not contradict it.

Your job is everything the skeleton cannot say:
- module_responsibilities: one plain sentence per module saying what it is FOR.
  Read enough of each module to say something true and specific. "Handles utilities"
  is a non-answer; "Encrypts GitHub tokens at rest and builds the AMQP/Redis client
  options every service shares" is an answer. Cover every module in the skeleton.
- request_flows: the 2-3 most important end-to-end paths. The Ground Truth already
  contains measured call chains — every hop in those is a real \`calls\` edge, and
  the report DRAWS THE DIAGRAMS FROM THOSE, not from your steps. So name and explain
  the flows: give each a \`name\` a reader recognises ("Analyse a repository", not
  "handleRequest") and a \`description\` saying what it accomplishes and what it
  touches. Put the chain's symbols in \`steps\` so the two can be matched up. If a
  flow you want to describe is not in the measured chains, trace it with search_nodes
  + get_callees first; if you cannot trace it, leave it out rather than inventing it.
- architecture_pattern and design_patterns: what is actually here, evidenced. Do not
  list "Repository" because the language usually has one — point at the code.
- summary: 3-6 sentences on the layers, how they collaborate, and the structural
  decisions worth knowing. Concrete. A newcomer should finish it knowing where to
  start reading.

A "module" is a top-level source directory or logical layer — never an individual
file, component, class or function. Use the names from the Ground Truth verbatim so
the report's tables and diagrams line up.`;

  buildUserMessage(ctx: AgentContext): string {
    return `Map the architecture of this codebase so a newcomer understands how it is wired together end to end.

## Code Graph Context (entry points, controllers, services, imports)
${ctx.graphContext}

${ctx.fileTree ? `## File Tree\n\`\`\`\n${ctx.fileTree}\n\`\`\`` : ''}`;
  }
}
