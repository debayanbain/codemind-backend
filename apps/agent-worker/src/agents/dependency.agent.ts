import { Injectable } from '@nestjs/common';
import { BaseAgent, AgentContext } from './base.agent';

@Injectable()
export class DependencyAgent extends BaseAgent {
  readonly agentType = 'dependency' as const;

  // The manifest is this agent's real input; the overview just tells it what
  // kind of project it's looking at. Routes and metrics would be noise.
  readonly factSections = ['overview'] as const;

  // Cheapest agent by far: the manifest is handed to it and the interesting part
  // is judgment, not search. It rarely needs more than a couple of turns.
  readonly maxTurns = 4;

  readonly rolePrompt = `Your brief: assess this project's dependency footprint and its risk.

The manifest is in your user message. Copy the dependency lists from it **verbatim** —
runtime_dependencies and dev_dependencies are transcription, not recall, and a package
you "remember" being here is a fabrication. If a manifest section is absent, return an
empty array rather than a plausible one.

Where you add value, and where you should spend your turns:
- outdated_risks: packages that are deprecated, unmaintained, or have known advisories.
  You have no network, so you are reasoning from what you know — say *why* each one is
  a risk, and only list packages you are actually confident about. A speculative CVE is
  worse than an empty list.
- critical_deps: the ones whose removal breaks the product. Use get_file_dependencies
  or search_nodes to check what the code genuinely leans on rather than guessing from
  the package name.
- version_conflicts: only if the manifest actually shows them.
- license_concerns: copyleft or commercial-restricted licenses in a project that looks
  like it does not want them.

summary: 2-4 sentences — the core stack, the size of the footprint, and the risks that
are real. Specific, not generic.`;

  buildUserMessage(ctx: AgentContext): string {
    return `Analyze this project's dependencies.

## Manifest File Content (read for you — transcribe from this, do not recall)
${ctx.additionalContext ?? 'Not available'}

## Code Graph Context (import/require patterns)
${ctx.graphContext}`;
  }
}
