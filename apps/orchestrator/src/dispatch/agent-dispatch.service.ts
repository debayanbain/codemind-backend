import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AGENT_ROUTING_KEYS, AgentType } from '@app/common';
import { RepoManifest } from '../manifest/repo-manifest.service';

export const AGENT_TOPIC_CLIENT = 'AGENT_TOPIC_CLIENT';

export interface AgentDispatchMessage {
  jobId: string;
  repoPath: string;
  agentType: AgentType;
  totalAgents: number;
  epoch: number; // run generation — worker drops messages whose epoch is stale
  manifest: {
    hasDockerfile: boolean;
    dominantLanguage: string | null;
    languageSupported: boolean;
  };
}

/**
 * Manifest-based agent selection (Section 5 step 5 / Section 8). Architecture,
 * security, quality, docs run unconditionally — a repo with no manifest file
 * still has an architecture and a docs story. Dependency is the one agent
 * that's genuinely inapplicable with nothing to parse, so it's the one
 * skipped outright; hasDockerfile/languageSupported instead ride along as
 * context so agents that DO run (e.g. security's container-check subsection)
 * can skip just that part of their own output.
 */
@Injectable()
export class AgentDispatchService {
  private readonly logger = new Logger(AgentDispatchService.name);

  constructor(
    @Inject(AGENT_TOPIC_CLIENT) private readonly client: ClientProxy,
  ) {}

  selectAgents(manifest: RepoManifest): AgentType[] {
    const agents: AgentType[] = ['architecture', 'security', 'quality', 'docs'];
    if (manifest.manifestFilesFound.length > 0) {
      agents.push('dependency');
    }
    return agents;
  }

  dispatch(
    jobId: string,
    repoPath: string,
    agentTypes: AgentType[],
    manifest: RepoManifest,
    epoch: number,
  ): void {
    const totalAgents = agentTypes.length;
    for (const agentType of agentTypes) {
      const message: AgentDispatchMessage = {
        jobId,
        repoPath,
        agentType,
        totalAgents,
        epoch,
        manifest: {
          hasDockerfile: manifest.hasDockerfile,
          dominantLanguage: manifest.dominantLanguage,
          languageSupported: manifest.languageSupported,
        },
      };
      this.client.emit(AGENT_ROUTING_KEYS[agentType], message);
      this.logger.log(`Dispatched [${agentType}] job=${jobId}`);
    }
  }
}
