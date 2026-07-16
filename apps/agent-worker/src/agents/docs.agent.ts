import { Injectable } from '@nestjs/common';
import { BaseAgent, AgentContext } from './base.agent';

@Injectable()
export class DocsAgent extends BaseAgent {
  readonly agentType = 'docs' as const;

  // Public surface per module + real routes: what a newcomer would need
  // documented, grounded in what actually exists.
  readonly factSections = ['overview', 'modules', 'routes'] as const;

  readonly rolePrompt = `Your brief: you are a technical writer judging whether this project
is approachable to someone who has just been handed it.

What to investigate:
- Read the README properly. Does it explain what the project IS, how to run it, and
  how to configure it? A long README that never says how to start the thing is a
  minimal one.
- Check for the files that signal a maintained project: CONTRIBUTING, CHANGELOG,
  LICENSE, .env.example. Use read_file — do not assume from the file tree.
- Sample the real public surface. Use get_code on a few exported symbols and see
  whether they carry doc comments. Do not estimate comment density from vibes;
  read some code and say what you saw.
- Cross-check the README against reality. A README that documents a setup step that
  no longer exists, or omits a service that does, is worse than a short one — that
  is the most valuable thing you can find here, so look for it.

doc_score is 0-100 and should track how fast a competent newcomer gets to a running
system, not how many words the docs contain.`;

  buildUserMessage(ctx: AgentContext): string {
    return `Evaluate the documentation of this codebase.

## README Content (already read for you)
${ctx.additionalContext ?? 'README not found'}

## Code Graph Context (public API focus)
${ctx.graphContext}`;
  }
}
