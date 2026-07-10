import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

import {
  PrismaService,
  JobEventPayload,
  AgentOutputsByType,
  SonnetSynthesisOutput,
  LlmClient,
  jobStatusKey,
  jobAgentsDoneKey,
  jobAgentsExpectedKey,
  jobEventsChannel,
  jobSynthesizingLockKey,
} from '@app/common';
import { MermaidBuilder } from '../mermaid/mermaid.builder';
import { ReportRenderer } from '../report/report-renderer.service';

const SONNET_MODEL = 'claude-sonnet-5';
const OPENAI_SYNTHESIS_MODEL =
  process.env.OPENAI_SYNTHESIS_MODEL ?? 'gpt-4o';

@Injectable()
export class SynthesizerService implements OnModuleInit {
  private readonly logger = new Logger(SynthesizerService.name);
  private readonly client = new LlmClient();
  private subscriber: Redis;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly mermaid: MermaidBuilder,
    private readonly renderer: ReportRenderer,
  ) {
    // Dedicated subscriber connection — a client used for pub/sub can't also issue commands.
    this.subscriber = redis.duplicate();
  }

  async onModuleInit(): Promise<void> {
    this.subscriber.on(
      'pmessage',
      (_pattern: string, channel: string, jobId: string) => {
        if (channel.endsWith(':ready_for_synthesis')) {
          this.synthesize(jobId).catch((err: unknown) => {
            this.logger.error(`Unhandled synthesis error [job=${jobId}]`, err);
          });
        }
      },
    );
    await this.subscriber.psubscribe('job:*:ready_for_synthesis');
    this.logger.log('Synthesizer listening for completed jobs');
  }

  async synthesize(jobId: string): Promise<void> {
    // Claim the job before doing anything — harmless at 1 replica, required
    // if this ever scales to more than 1 (every replica hears the same
    // pub/sub message). Lock expires on its own so a crash mid-synthesis
    // doesn't strand the job unclaimed forever.
    const claimed = await this.redis.set(
      jobSynthesizingLockKey(jobId),
      '1',
      'EX',
      300,
      'NX',
    );
    if (!claimed) {
      this.logger.debug(`Synthesis already claimed [job=${jobId}], skipping`);
      return;
    }

    this.logger.log(`Synthesis started [job=${jobId}]`);
    const t = Date.now();

    try {
      // 1. Load all agent results from Postgres. rawOutput is untyped LLM JSON
      //    at the DB boundary — one explicit cast here, typed everywhere after.
      const results = await this.prisma.agentResult.findMany({
        where: { jobId },
      });
      const byType = Object.fromEntries(
        results.map((r) => [r.agentType, r.rawOutput]),
      ) as AgentOutputsByType;

      const arch = byType.architecture ?? {};
      const sec = byType.security ?? {};
      const dep = byType.dependency ?? {};
      const qual = byType.quality ?? {};

      // 2. Build all Mermaid diagrams programmatically — ZERO LLM calls
      const diagrams = {
        architectureGraph: this.mermaid.moduleGraph(arch),
        requestFlow: (arch.request_flows ?? []).map((f) => ({
          name: f.name,
          mermaid: this.mermaid.sequenceDiagram(f.steps),
        })),
        securityFlow: this.mermaid.securityFlow(sec),
        dependencyGraph: this.mermaid.dependencyGraph(dep),
        qualityPie: this.mermaid.qualityPie(qual),
      };

      // 3. ONE Sonnet call for executive summary + recommendations only.
      //    Agents already did the extraction — Sonnet does cross-agent reasoning.
      const synthesis = await this.callSonnet(byType);

      // 4. Render the full Markdown report
      const markdown = this.renderer.render({
        jobId,
        agentOutputs: byType,
        diagrams,
        synthesis,
        totalTokens: results.reduce((sum, r) => {
          const tokens = r.tokensUsed as {
            input?: number;
            output?: number;
          } | null;
          return sum + (tokens?.input ?? 0) + (tokens?.output ?? 0);
        }, 0),
      });

      // 5. Persist
      await this.prisma.report.create({
        data: { jobId, markdownContent: markdown },
      });
      await this.prisma.job.update({
        where: { id: jobId },
        data: { status: 'done', completedAt: new Date() },
      });
      await this.redis.set(jobStatusKey(jobId), 'done');
      await this.redis.del(
        jobAgentsDoneKey(jobId),
        jobAgentsExpectedKey(jobId),
      );

      const event: JobEventPayload = { type: 'job:complete', jobId };
      await this.redis.publish(jobEventsChannel(jobId), JSON.stringify(event));

      this.logger.log(
        `Synthesis complete in ${Date.now() - t}ms [job=${jobId}] | report=${markdown.length} chars`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Synthesis failed [job=${jobId}]: ${message}`);

      await this.prisma.job.update({
        where: { id: jobId },
        data: { status: 'failed', completedAt: new Date() },
      });
      await this.redis.set(jobStatusKey(jobId), 'failed');

      const event: JobEventPayload = {
        type: 'job:failed',
        jobId,
        reason: message,
      };
      await this.redis.publish(jobEventsChannel(jobId), JSON.stringify(event));
    }
  }

  private async callSonnet(
    byType: AgentOutputsByType,
  ): Promise<SonnetSynthesisOutput> {
    const response = await this.client.complete({
      anthropicModel: SONNET_MODEL,
      openaiModel: OPENAI_SYNTHESIS_MODEL,
      maxTokens: 1000,
      system: `You are a principal engineer writing a brief technical assessment.
        Respond ONLY with valid JSON. No preamble, no markdown fences.
        Schema:
        {
          "executiveSummary": string,    // 3-4 sentences, cross-cutting insight from all agents
          "recommendations": string[],  // top 5 actionable recommendations, ordered by priority
          "overallHealthScore": number  // 0-100 codebase health score
        }`,
      user: `Here are structured outputs from specialized analysis agents for the same codebase.

          Write an executive summary and prioritized recommendations based on cross-agent patterns.

          ## Architecture Agent Output
          ${JSON.stringify(byType.architecture ?? {}, null, 2)}

          ## Security Agent Output
          ${JSON.stringify(byType.security ?? {}, null, 2)}

          ## Dependency Agent Output
          ${JSON.stringify(byType.dependency ?? {}, null, 2)}

          ## Quality Agent Output
          ${JSON.stringify(byType.quality ?? {}, null, 2)}

          ## Docs Agent Output
          ${JSON.stringify(byType.docs ?? {}, null, 2)}

          Return only JSON.`,
    });

    try {
      return JSON.parse(
        response.text.replace(/```json\n?|```/g, '').trim(),
      ) as SonnetSynthesisOutput;
    } catch {
      return {
        executiveSummary: 'Analysis complete. See individual sections below.',
        recommendations: [],
        overallHealthScore: 50,
      };
    }
  }
}
