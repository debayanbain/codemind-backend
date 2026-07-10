import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService, JobStatus } from '@app/common';
import {
  AgentResultSummary,
  JobsService,
  ReportPayload,
  toReportPayload,
} from './jobs.service';

/** 32 bytes of entropy, base64url — not enumerable, safe in a URL and a log line. */
const TOKEN_BYTES = 32;

export interface ShareLink {
  token: string;
  createdAt: Date;
}

/**
 * What a share-link viewer gets. Deliberately not the owner's `Job`: no
 * `userId`, no job id, no retry affordances. A viewer sees the report and who
 * shared it, nothing that lets them act on the job.
 */
export interface SharedReport {
  repoFullName: string;
  status: JobStatus;
  createdAt: Date;
  completedAt: Date | null;
  sharedBy: { githubUsername: string | null; avatarUrl: string | null };
  report: ReportPayload;
  agentResults: AgentResultSummary[];
}

@Injectable()
export class ShareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobsService: JobsService,
  ) {}

  /**
   * Idempotent per job: re-sharing returns the existing live link rather than
   * minting a second token, so "Copy link" twice can't produce two capabilities
   * the owner then has to revoke separately.
   */
  async createOrGetLink(jobId: string, userId: string): Promise<ShareLink> {
    const report = await this.ownedReport(jobId, userId);

    const existing = await this.prisma.reportShare.findFirst({
      where: { reportId: report.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return { token: existing.token, createdAt: existing.createdAt };
    }

    const share = await this.prisma.reportShare.create({
      data: {
        reportId: report.id,
        createdById: userId,
        token: randomBytes(TOKEN_BYTES).toString('base64url'),
      },
    });
    return { token: share.token, createdAt: share.createdAt };
  }

  async getLink(jobId: string, userId: string): Promise<ShareLink | null> {
    const report = await this.ownedReport(jobId, userId);
    const share = await this.prisma.reportShare.findFirst({
      where: { reportId: report.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return share ? { token: share.token, createdAt: share.createdAt } : null;
  }

  /** Revokes every live link for the job — one button, one guarantee. */
  async revokeLinks(jobId: string, userId: string): Promise<void> {
    const report = await this.ownedReport(jobId, userId);
    await this.prisma.reportShare.updateMany({
      where: { reportId: report.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Redeems a token for any authenticated user — ownership is deliberately not
   * checked, that is what the link is for. A revoked or unknown token is a 404,
   * never a 403: a viewer must not be able to tell "wrong token" from
   * "token that used to work".
   */
  async getSharedReport(token: string): Promise<SharedReport> {
    const share = await this.prisma.reportShare.findUnique({
      where: { token },
      include: {
        createdBy: true,
        report: { include: { job: true } },
      },
    });

    if (!share || share.revokedAt) {
      throw new NotFoundException('Share link not found');
    }

    const { report } = share;
    return {
      repoFullName: report.job.repoFullName,
      status: report.job.status,
      createdAt: report.job.createdAt,
      completedAt: report.job.completedAt,
      sharedBy: {
        githubUsername: share.createdBy.githubUsername,
        avatarUrl: share.createdBy.avatarUrl,
      },
      report: toReportPayload(report),
      agentResults: await this.jobsService.getLatestAgentResults(report.jobId),
    };
  }

  /** 404 (not 403) on ownership mismatch — don't leak that the job exists. */
  private async ownedReport(jobId: string, userId: string) {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: { report: true },
    });
    if (!job || job.userId !== userId) {
      throw new NotFoundException('Job not found');
    }
    if (!job.report) {
      throw new NotFoundException('Report not ready yet');
    }
    return job.report;
  }
}
