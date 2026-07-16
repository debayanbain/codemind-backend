import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import * as crypto from 'crypto';
import CodeGraph, {
  GraphStats,
  SearchResult,
  Subgraph,
  FileRecord,
} from '@colbymchenry/codegraph';
import { agentContextKey } from '../constants/redis.constants';

/**
 * Thin wrapper around @colbymchenry/codegraph, used programmatically (never
 * the MCP server or CLI, per project spec). Two entry points, one per process
 * role:
 *
 *  - `initAndIndex` — orchestrator only. Runs the AST extraction (zero LLM
 *    cost) once per job and persists the SQLite DB under the repo's
 *    `.codegraph/` directory.
 *  - `openReadOnly` — agent-worker only. Re-opens that same on-disk DB in a
 *    separate process (WAL mode allows concurrent readers), since the
 *    orchestrator's in-process instance isn't visible across processes.
 *
 * Each process keeps its own small in-memory cache so the 5 agent handlers in
 * agent-worker share one open handle per run instead of re-opening the DB per
 * agent.
 *
 * The cache key is the **repo path**, never the jobId. A force-stop bumps
 * `job:{id}:epoch` and the orchestrator extracts the new run to
 * `/tmp/repos/{jobId}-{epoch}` — a different directory holding a different
 * graph. Keying by jobId meant run 1's agents hit the cache and silently
 * queried run 0's abandoned index, producing a report for a checkout the user
 * had already replaced. Keying by the path makes that unrepresentable: the key
 * is the identity of the thing being opened.
 *
 * Values are the in-flight *promise*, not the resolved handle. Five consumers
 * reach this concurrently; a check-then-await gap let all five miss the cache,
 * open five handles, and leak four.
 */
@Injectable()
export class CodeGraphService implements OnModuleDestroy {
  private readonly logger = new Logger(CodeGraphService.name);
  private readonly graphs = new Map<string, Promise<CodeGraph>>();

  constructor(@InjectRedis() private readonly redis: Redis) {}

  initAndIndex(repoPath: string, jobId: string): Promise<CodeGraph> {
    const existing = this.graphs.get(repoPath);
    if (existing) return existing;

    this.logger.log(`Indexing repo [job=${jobId}] path=${repoPath}`);
    const t = Date.now();

    const indexing = (async () => {
      const cg = await CodeGraph.init(repoPath);
      const result = await cg.indexAll();
      this.logger.log(
        `Graph ready in ${Date.now() - t}ms [job=${jobId}] files=${result.filesIndexed ?? '?'}`,
      );
      return cg;
    })().catch((e: unknown) => {
      // Never cache a rejection — a transient index failure would otherwise
      // poison every later open of this path for the process's lifetime.
      this.graphs.delete(repoPath);
      throw e;
    });

    this.graphs.set(repoPath, indexing);
    return indexing;
  }

  openReadOnly(repoPath: string, jobId: string): Promise<CodeGraph> {
    const existing = this.graphs.get(repoPath);
    if (existing) return existing;

    this.logger.debug(
      `Opening graph read-only [job=${jobId}] path=${repoPath}`,
    );
    const opening = CodeGraph.open(repoPath, { readOnly: true }).catch(
      (e: unknown) => {
        this.graphs.delete(repoPath);
        throw e;
      },
    );

    this.graphs.set(repoPath, opening);
    return opening;
  }

  /**
   * buildContext with Redis cache keyed by (runKey, agentType, query hash) —
   * Section 6's `agent_context:{jobId}:{agentType}:{queryHash}`, with the
   * jobId slot widened to `{jobId}-{epoch}`. If two agents issue the same
   * query, skip the formatting work and reuse the cached markdown. TTL: 24h.
   *
   * The scope must be the runKey, not the jobId, for the same reason the
   * handle cache is keyed by path: with a bare jobId and a 24h TTL, a
   * force-retry served run 1 the context built from run 0's graph.
   */
  async buildContext(
    cg: CodeGraph,
    query: string,
    runKey: string,
    agentType: string,
    maxNodes = 20,
  ): Promise<string> {
    const key = agentContextKey(runKey, agentType, this.hash(query));
    const hit = await this.redis.get(key);
    if (hit) {
      this.logger.debug(
        `Context cache hit [${agentType}] query="${query.slice(0, 40)}..."`,
      );
      return hit;
    }

    const ctx = await cg.buildContext(query, {
      maxNodes,
      includeCode: true,
      format: 'markdown',
    });
    const text = typeof ctx === 'string' ? ctx : JSON.stringify(ctx);

    await this.redis.set(key, text, 'EX', 86400);
    return text;
  }

  searchNodes(cg: CodeGraph, query: string): SearchResult[] {
    return cg.searchNodes(query);
  }

  getCallers(cg: CodeGraph, nodeId: string) {
    return cg.getCallers(nodeId);
  }

  getCallees(cg: CodeGraph, nodeId: string) {
    return cg.getCallees(nodeId);
  }

  getFiles(cg: CodeGraph): FileRecord[] {
    return cg.getFiles();
  }

  getImpactRadius(cg: CodeGraph, nodeId: string, maxDepth?: number): Subgraph {
    return cg.getImpactRadius(nodeId, maxDepth);
  }

  getStats(cg: CodeGraph): GraphStats {
    return cg.getStats();
  }

  /**
   * Close and evict one run's graph handle (called once all agents for that
   * run are done). Takes the repo path — the same key `openReadOnly` used, so
   * a stale run can never close the live run's handle.
   */
  close(repoPath: string): void {
    const opening = this.graphs.get(repoPath);
    if (!opening) return;
    this.graphs.delete(repoPath);
    // The handle may still be opening; close it whenever it lands. Swallow the
    // rejection — a graph that failed to open has nothing to close.
    void opening.then(
      (cg) => cg.close(),
      () => undefined,
    );
  }

  async onModuleDestroy() {
    const closing = [...this.graphs.values()].map((p) =>
      p.then(
        (cg) => cg.close(),
        () => undefined,
      ),
    );
    this.graphs.clear();
    await Promise.allSettled(closing);
  }

  private hash(s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
  }
}
