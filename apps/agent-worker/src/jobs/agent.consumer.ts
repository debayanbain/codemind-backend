import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  AGENT_ROUTING_KEYS,
  PrismaService,
  AgentType,
  CodeGraphService,
  JobEventPayload,
  jobAgentsDoneKey,
  jobAgentsExpectedKey,
  jobEventsChannel,
  jobReadyForSynthesisChannel,
  jobTokensUsedKey,
  jobEpochKey,
} from '@app/common';

import { ArchitectureAgent } from '../agents/architecture.agent';
import { SecurityAgent } from '../agents/security.agent';
import { DependencyAgent } from '../agents/dependency.agent';
import { QualityAgent } from '../agents/quality.agent';
import { DocsAgent } from '../agents/docs.agent';
import { AgentContext, AgentResult } from '../agents/base.agent';
import { AgentFailureRecorderService } from './agent-failure-recorder.service';

export interface AgentJobMessage {
  jobId: string;
  repoPath: string; // /tmp/repos/{jobId}/ — extracted tarball
  agentType: AgentType;
  totalAgents: number; // informational only — completion is decided via Redis agents_expected
  epoch?: number; // run generation; message is dropped if it doesn't match Redis job:{id}:epoch
  manifest: {
    hasDockerfile: boolean;
    dominantLanguage: string | null;
    languageSupported: boolean;
  };
}

interface AckableChannel {
  ack(message: unknown): void;
  nack(message: unknown, allUpTo: boolean, requeue: boolean): void;
}

@Controller()
export class AgentConsumer {
  private readonly logger = new Logger(AgentConsumer.name);

  constructor(
    private readonly codeGraphService: CodeGraphService,
    private readonly architectureAgent: ArchitectureAgent,
    private readonly securityAgent: SecurityAgent,
    private readonly dependencyAgent: DependencyAgent,
    private readonly qualityAgent: QualityAgent,
    private readonly docsAgent: DocsAgent,
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly failureRecorder: AgentFailureRecorderService,
  ) {}

  @EventPattern(AGENT_ROUTING_KEYS.architecture)
  async onArchitecture(
    @Payload() msg: AgentJobMessage,
    @Ctx() ctx: RmqContext,
  ) {
    await this.handle(msg, ctx, async (agentCtx) => {
      const fileTree = await this.buildFileTree(msg.repoPath);
      return this.architectureAgent.run({ ...agentCtx, fileTree });
    });
  }

  @EventPattern(AGENT_ROUTING_KEYS.security)
  async onSecurity(@Payload() msg: AgentJobMessage, @Ctx() ctx: RmqContext) {
    await this.handle(msg, ctx, async (agentCtx) => {
      const note = msg.manifest.hasDockerfile
        ? 'Dockerfile present — container-security checks are in scope.'
        : 'No Dockerfile found — do not report container-security findings.';
      return this.securityAgent.run({ ...agentCtx, additionalContext: note });
    });
  }

  @EventPattern(AGENT_ROUTING_KEYS.dependency)
  async onDependency(@Payload() msg: AgentJobMessage, @Ctx() ctx: RmqContext) {
    await this.handle(msg, ctx, async (agentCtx) => {
      // Dependency agent needs the raw manifest — read directly, tiny file, zero graph cost.
      const manifest = await this.readManifest(msg.repoPath);
      return this.dependencyAgent.run({
        ...agentCtx,
        additionalContext: manifest,
      });
    });
  }

  @EventPattern(AGENT_ROUTING_KEYS.quality)
  async onQuality(@Payload() msg: AgentJobMessage, @Ctx() ctx: RmqContext) {
    await this.handle(msg, ctx, async (agentCtx) =>
      this.qualityAgent.run(agentCtx),
    );
  }

  @EventPattern(AGENT_ROUTING_KEYS.docs)
  async onDocs(@Payload() msg: AgentJobMessage, @Ctx() ctx: RmqContext) {
    await this.handle(msg, ctx, async (agentCtx) => {
      // Docs agent needs the README — read directly, tiny file, zero graph cost.
      const readme = await this.readReadme(msg.repoPath);
      return this.docsAgent.run({ ...agentCtx, additionalContext: readme });
    });
  }

  // ─── Core dispatch logic ────────────────────────────────────────────────────

  private async handle(
    msg: AgentJobMessage,
    ctx: RmqContext,
    run: (agentCtx: AgentContext) => Promise<AgentResult>,
  ) {
    const channel = ctx.getChannelRef() as AckableChannel;
    const originalMsg = ctx.getMessage();
    const { jobId, repoPath, agentType } = msg;

    this.logger.log(`[${agentType}] starting job=${jobId}`);

    try {
      // Step -1: fencing. A force-stop bumps job:{id}:epoch; any message from
      // the superseded run carries the old epoch and is dropped here — before
      // it can write a stale AgentResult or SADD into agents_done and trip
      // completion for a run the user already abandoned. Ack (not nack) so it
      // leaves the queue for good rather than dead-lettering.
      const currentEpoch = Number(
        (await this.redis.get(jobEpochKey(jobId))) ?? 0,
      );
      if ((msg.epoch ?? 0) !== currentEpoch) {
        this.logger.warn(
          `[${agentType}] dropping stale message (msg epoch ${msg.epoch ?? 0} != current ${currentEpoch}) [job=${jobId}]`,
        );
        channel.ack(originalMsg);
        return;
      }

      // Step 0: cost cap (Phase 4). Checked before every LLM call, not after —
      // once the shared per-job counter crosses budget, agents still queued
      // behind this one skip the call entirely instead of adding more spend.
      const budget = this.config.get<number>('JOB_TOKEN_BUDGET', 100_000);
      const spent = Number(
        (await this.redis.get(jobTokensUsedKey(jobId))) ?? 0,
      );

      let result: AgentResult;
      if (spent >= budget) {
        this.logger.warn(
          `[${agentType}] skipped — job token budget exceeded (${spent}/${budget}) [job=${jobId}]`,
        );
        result = {
          agentType,
          jobId,
          output: {},
          tokensUsed: { input: 0, output: 0 },
          success: false,
          error: `Job token budget exceeded (${spent}/${budget})`,
          durationMs: 0,
        };
      } else {
        // Step 1: re-open the already-built graph read-only (built by the orchestrator,
        // in a different process — WAL mode means readers never block on that writer).
        const cg = await this.codeGraphService.openReadOnly(repoPath, jobId);

        // Step 2: agent-specific semantic query -> only relevant nodes returned.
        const graphContext = await this.codeGraphService.buildContext(
          cg,
          this.queryFor(agentType),
          jobId,
          agentType,
          20, // max nodes = hard cap on context size
        );

        // Step 3: run the agent.
        result = await run({ jobId, repoPath, graphContext });

        if (result.success) {
          await this.redis.incrby(
            jobTokensUsedKey(jobId),
            result.tokensUsed.input + result.tokensUsed.output,
          );
        }
      }

      // Step 4: persist result to Postgres. Malformed/failed output never crashes
      // the job — it's recorded as a failed agent and the synthesizer proceeds
      // with whatever succeeded.
      await this.prisma.agentResult.create({
        data: {
          jobId,
          agentType,
          rawOutput: result.output,
          tokensUsed: result.tokensUsed,
          status: result.success ? 'success' : 'failed',
          durationMs: result.durationMs,
          error: result.error ?? null,
        },
      });

      // Step 5: track completion in Redis against what the orchestrator actually
      // dispatched (agents_expected), not the message's own totalAgents field.
      await this.redis.sadd(jobAgentsDoneKey(jobId), agentType);
      const [doneCount, expectedCount] = await Promise.all([
        this.redis.scard(jobAgentsDoneKey(jobId)),
        this.redis.scard(jobAgentsExpectedKey(jobId)),
      ]);

      this.logger.log(
        `[${agentType}] saved. Progress: ${doneCount}/${expectedCount} [job=${jobId}]`,
      );

      const progressEvent: JobEventPayload = {
        type: 'job:progress',
        jobId,
        agentType,
        done: doneCount,
        total: expectedCount,
      };
      await this.redis.publish(
        jobEventsChannel(jobId),
        JSON.stringify(progressEvent),
      );

      if (doneCount >= expectedCount) {
        this.codeGraphService.close(jobId);
        // Last agent standing deletes the extracted repo + its CodeGraph
        // SQLite DB (lives under repoPath/.codegraph) — otherwise every
        // completed job leaks a full checkout on disk indefinitely.
        await fs
          .rm(repoPath, { recursive: true, force: true })
          .catch((e: unknown) => {
            this.logger.warn(`Failed to clean up ${repoPath}: ${String(e)}`);
          });
        await this.redis.publish(jobReadyForSynthesisChannel(jobId), jobId);
        this.logger.log(`All agents done, synthesis triggered [job=${jobId}]`);
      }

      channel.ack(originalMsg);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${agentType}] fatal error job=${jobId}: ${message}`);
      // An infra failure here (graph open, buildContext, Postgres write) means
      // this agent never reached Step 4/5 — without recording *something*,
      // agents_done never reaches agents_expected and the job hangs forever.
      // Record it as failed and still advance completion tracking so the
      // synthesizer proceeds with whatever other agents succeeded.
      await this.failureRecorder
        .recordInfraFailure(jobId, repoPath, agentType, message)
        .catch((e: unknown) => {
          this.logger.error(
            `[${agentType}] failed to record infra failure: ${String(e)}`,
          );
        });
      channel.nack(originalMsg, false, false);
    }
  }

  // ─── Agent-specific graph queries (Section 8) ──────────────────────────────

  private queryFor(agentType: AgentType): string {
    const queries: Record<AgentType, string> = {
      architecture:
        'entry point main module bootstrap controller service provider dependency injection',
      security:
        'authentication authorization guard jwt token password hash input validation user request',
      dependency: 'import require external library package third party module',
      quality:
        'error handling exception try catch async await promise rejection type any unknown',
      docs: 'export public interface type definition API contract decorator description',
    };
    return queries[agentType];
  }

  // ─── File helpers (zero LLM cost) ───────────────────────────────────────────

  private async readManifest(repoPath: string): Promise<string> {
    const candidates = [
      'package.json',
      'requirements.txt',
      'go.mod',
      'Cargo.toml',
      'pom.xml',
    ];
    for (const f of candidates) {
      try {
        return await fs.readFile(path.join(repoPath, f), 'utf-8');
      } catch {
        // try next candidate
      }
    }
    return 'No manifest file found';
  }

  private async readReadme(repoPath: string): Promise<string> {
    const candidates = ['README.md', 'README.txt', 'README', 'readme.md'];
    for (const f of candidates) {
      try {
        const content = await fs.readFile(path.join(repoPath, f), 'utf-8');
        return content.slice(0, 8000); // README can be huge, cap it
      } catch {
        // try next candidate
      }
    }
    return 'No README found';
  }

  private async buildFileTree(
    repoPath: string,
    maxFiles = 200,
  ): Promise<string> {
    const lines: string[] = [];
    let count = 0;

    const walk = async (dir: string, indent = 0) => {
      if (count >= maxFiles) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        lines.push(`${'  '.repeat(indent)}${e.name}`);
        count++;
        if (e.isDirectory()) await walk(path.join(dir, e.name), indent + 1);
        if (count >= maxFiles) {
          lines.push('  ... (truncated)');
          return;
        }
      }
    };

    await walk(repoPath);
    return lines.join('\n');
  }
}
