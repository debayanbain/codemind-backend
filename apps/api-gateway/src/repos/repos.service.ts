import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PrismaService, JobStatus } from '@app/common';
import { AuthService } from '../auth/auth.service';

export interface LanguageStat {
  name: string;
  percent: number; // 0-100, one decimal
  color: string | null; // GitHub's canonical language color
  bytes: number;
}

export interface GithubRepoSummary {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
  language: string | null;
  languages: LanguageStat[];
  htmlUrl: string;
  lastJobId: string | null;
  lastJobStatus: JobStatus | null;
}

// Show at most this many languages per card; the long tail of <1% languages
// adds noise, not signal.
const MAX_LANGUAGES = 6;
// GitHub caps a connection page at 100 nodes.
const REPOS_PER_PAGE = 100;
// Safety valve so a runaway account can't loop forever.
const MAX_PAGES = 20;

interface GraphQlLanguageEdge {
  size: number;
  node: { name: string; color: string | null };
}

interface GraphQlRepoNode {
  databaseId: number | null;
  nameWithOwner: string;
  isPrivate: boolean;
  url: string;
  updatedAt: string;
  defaultBranchRef: { name: string } | null;
  primaryLanguage: { name: string } | null;
  languages: { totalSize: number; edges: GraphQlLanguageEdge[] } | null;
}

interface GraphQlReposResponse {
  data?: {
    viewer?: {
      repositories: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: GraphQlRepoNode[];
      };
    };
  };
  errors?: { message: string }[];
}

// One query pulls every repo AND its language breakdown (with GitHub's own
// language colors) in a single round trip — no per-repo N+1 calls.
const REPOS_QUERY = `
  query Repos($cursor: String, $pageSize: Int!) {
    viewer {
      repositories(
        first: $pageSize
        after: $cursor
        affiliations: [OWNER, COLLABORATOR]
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          databaseId
          nameWithOwner
          isPrivate
          url
          updatedAt
          defaultBranchRef { name }
          primaryLanguage { name }
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            totalSize
            edges {
              size
              node { name color }
            }
          }
        }
      }
    }
  }
`;

@Injectable()
export class ReposService {
  private readonly logger = new Logger(ReposService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  async listRepos(userId: string): Promise<GithubRepoSummary[]> {
    // Fetch a fresh GitHub token from Clerk (and persist it encrypted). Throws
    // 409 github_not_connected for a user with no linked GitHub — the frontend
    // shows the Connect GitHub card instead of an empty/failed list.
    const token = await this.authService.ensureGithubToken(userId);
    const nodes = await this.fetchAllRepoNodes(token);

    const lastJobByRepo = await this.getLastJobsByRepo(
      userId,
      nodes.map((n) => n.nameWithOwner),
    );

    return (
      nodes
        // A repo without a numeric databaseId can't be reconciled with the rest
        // of the system (jobs key off it), so skip it defensively.
        .filter(
          (n): n is GraphQlRepoNode & { databaseId: number } =>
            n.databaseId != null,
        )
        .map((n) => {
          const lastJob = lastJobByRepo.get(n.nameWithOwner);
          return {
            id: n.databaseId,
            fullName: n.nameWithOwner,
            private: n.isPrivate,
            defaultBranch: n.defaultBranchRef?.name ?? 'main',
            updatedAt: n.updatedAt,
            language: n.primaryLanguage?.name ?? null,
            languages: this.toLanguageStats(n.languages),
            htmlUrl: n.url,
            lastJobId: lastJob?.id ?? null,
            lastJobStatus: lastJob?.status ?? null,
          };
        })
    );
  }

  /** Page through the GraphQL repositories connection until exhausted. */
  private async fetchAllRepoNodes(token: string): Promise<GraphQlRepoNode[]> {
    const all: GraphQlRepoNode[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const connection = await this.runReposQuery(token, cursor);
      all.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) break;
      cursor = connection.pageInfo.endCursor;
      if (!cursor) break;
    }

    return all;
  }

  private async runReposQuery(
    token: string,
    cursor: string | null,
  ): Promise<{
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: GraphQlRepoNode[];
  }> {
    let res: Response;
    try {
      res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `bearer ${token}`,
          'User-Agent': 'CodeMind',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: REPOS_QUERY,
          variables: { cursor, pageSize: REPOS_PER_PAGE },
        }),
      });
    } catch (err) {
      this.logger.error(`GitHub GraphQL request failed: ${String(err)}`);
      throw new InternalServerErrorException(
        'Failed to fetch repositories from GitHub',
      );
    }

    if (!res.ok) {
      this.logger.error(
        `GitHub GraphQL failed: ${res.status} ${res.statusText}`,
      );
      throw new InternalServerErrorException(
        'Failed to fetch repositories from GitHub',
      );
    }

    const body = (await res.json()) as GraphQlReposResponse;

    if (body.errors?.length) {
      this.logger.error(
        `GitHub GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`,
      );
    }

    const repositories = body.data?.viewer?.repositories;
    if (!repositories) {
      throw new InternalServerErrorException(
        'Failed to fetch repositories from GitHub',
      );
    }

    return repositories;
  }

  /** GraphQL language edges -> top-N languages as sorted percentages. */
  private toLanguageStats(
    languages: GraphQlRepoNode['languages'],
  ): LanguageStat[] {
    if (!languages || languages.totalSize === 0) return [];
    const { totalSize, edges } = languages;

    return edges
      .map((e) => ({
        name: e.node.name,
        color: e.node.color,
        bytes: e.size,
        percent: Math.round((e.size / totalSize) * 1000) / 10,
      }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, MAX_LANGUAGES);
  }

  /** Latest job per repo, so the frontend can link straight to an existing report instead of re-analyzing. */
  private async getLastJobsByRepo(
    userId: string,
    repoFullNames: string[],
  ): Promise<Map<string, { id: string; status: JobStatus }>> {
    const jobs = await this.prisma.job.findMany({
      where: { userId, repoFullName: { in: repoFullNames } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, repoFullName: true, status: true },
    });

    const lastJobByRepo = new Map<string, { id: string; status: JobStatus }>();
    for (const job of jobs) {
      if (!lastJobByRepo.has(job.repoFullName)) {
        lastJobByRepo.set(job.repoFullName, { id: job.id, status: job.status });
      }
    }
    return lastJobByRepo;
  }
}
