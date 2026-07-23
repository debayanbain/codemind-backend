import { Injectable } from '@nestjs/common';
import { BaseAgent, AgentContext } from './base.agent';

@Injectable()
export class DependencyAgent extends BaseAgent {
  readonly agentType = 'dependency' as const;

  // The manifest is this agent's real input; the overview just tells it what
  // kind of project it's looking at. Routes and metrics would be noise.
  readonly factSections = [
    'overview',
    'dependencies',
    'externalImports',
  ] as const;

  // Cheapest agent by far: the manifest is handed to it and the interesting part
  // is judgment, not search. It rarely needs more than a couple of turns.
  readonly maxTurns = 6;

  readonly rolePrompt = `Your brief: assess this project's dependency footprint and its risk.

The Ground Truth already contains the **parsed** dependency list with exact versions,
and a measured map of which module imports which package. That is the transcription,
done for you and done exactly. Copy names from it verbatim into runtime_dependencies
and dev_dependencies; a package you "remember" being here is a fabrication.

Where you add value, and where you should spend your turns:
- outdated_risks: packages that are deprecated, unmaintained, or have known advisories.
  You have no network, so you are reasoning from what you know — but you DO have exact
  versions, so say *why* each one is a risk and reference the version you were given.
  Only list packages you are actually confident about; a speculative CVE is worse than
  an empty list.
- critical_deps: the ones whose removal breaks the product. The import map tells you
  how widely each package is actually used and by which module — lean on that rather
  than guessing from the package name.
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
