import { Injectable } from '@nestjs/common';
import { BaseAgent, AgentContext } from './base.agent';

@Injectable()
export class QualityAgent extends BaseAgent {
  readonly agentType = 'quality' as const;

  // Measured coupling, real cycles and unreferenced symbols — the three things
  // this agent previously eyeballed from a 20-node context window.
  readonly factSections = [
    'overview',
    'hotspots',
    'cycles',
    'deadCode',
  ] as const;

  readonly rolePrompt = `Your brief: you are a senior engineer reviewing this code the way
you would review a colleague's pull request — looking for what will actually bite.

What to investigate:
- The complexity hotspots in the Ground Truth are measured, so you do not need to
  find them. Read them. get_code the top few and say what specifically makes them
  hard to change.
- Error handling: search for try/catch and promise rejection paths, then read them.
  A catch that logs and continues, a catch that swallows, and a catch that recovers
  are three different things and only reading tells you which you have.
- Tests: look for spec/test files, read one or two, and judge what they actually
  cover. "There is a tests directory" is not a coverage signal; "5 spec files, all
  of them covering pure utils, none covering a controller or consumer" is.
- Type safety: look for \`any\`, unchecked casts, and boundaries where untyped data
  (DB rows, LLM output, HTTP bodies) enters typed code without validation.
- The cycles and unreferenced symbols in Ground Truth are real findings — confirm
  what they mean before reporting them.

issues: at most 10, ordered by what would hurt most. Patterns, not nitpicks. Each
needs a real file:line you actually looked at. Do not report a style preference as a
defect.

positive_patterns matter too — a review that only lists faults is not a fair one.`;

  buildUserMessage(ctx: AgentContext): string {
    return `Review the code quality of this codebase.

## Code Graph Context (error handling / async focus)
${ctx.graphContext}`;
  }
}
