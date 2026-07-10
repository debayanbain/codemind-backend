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
 * Each process keeps its own small in-memory cache keyed by jobId so the 5
 * agent handlers in agent-worker share one open handle per job instead of
 * re-opening the DB per agent.
 */
@Injectable()
export class CodeGraphService implements OnModuleDestroy {
  private readonly logger = new Logger(CodeGraphService.name);
  private readonly graphs = new Map<string, CodeGraph>();

  constructor(@InjectRedis() private readonly redis: Redis) {}

  async initAndIndex(repoPath: string, jobId: string): Promise<CodeGraph> {
    if (this.graphs.has(jobId)) return this.graphs.get(jobId)!;

    this.logger.log(`Indexing repo [job=${jobId}] path=${repoPath}`);
    const t = Date.now();

    const cg = await CodeGraph.init(repoPath);
    const result = await cg.indexAll();

    this.graphs.set(jobId, cg);
    this.logger.log(
      `Graph ready in ${Date.now() - t}ms [job=${jobId}] files=${result.filesIndexed ?? '?'}`,
    );
    return cg;
  }

  async openReadOnly(repoPath: string, jobId: string): Promise<CodeGraph> {
    if (this.graphs.has(jobId)) return this.graphs.get(jobId)!;

    const cg = await CodeGraph.open(repoPath, { readOnly: true });
    this.graphs.set(jobId, cg);
    return cg;
  }

  /**
   * buildContext with Redis cache keyed by (jobId, agentType, query hash) —
   * Section 6's `agent_context:{jobId}:{agentType}:{queryHash}`. If two
   * agents (or a re-run) issue the same query, skip the LLM-adjacent
   * formatting work and reuse the cached markdown context. TTL: 24h.
   */
  async buildContext(
    cg: CodeGraph,
    query: string,
    jobId: string,
    agentType: string,
    maxNodes = 20,
  ): Promise<string> {
    const key = agentContextKey(jobId, agentType, this.hash(query));
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

  /** Close and evict one job's graph handle (called once all agents for that job are done). */
  close(jobId: string): void {
    const cg = this.graphs.get(jobId);
    if (!cg) return;
    cg.close();
    this.graphs.delete(jobId);
  }

  onModuleDestroy() {
    for (const cg of this.graphs.values()) cg.close();
    this.graphs.clear();
  }

  private hash(s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
  }
}
