/**
 * Redis key schema — Section 6 of CLAUDE.md, implemented exactly as specified.
 * Use these builders everywhere instead of hand-writing key strings.
 */

export const jobStatusKey = (jobId: string) => `job:${jobId}:status`;

export const jobGraphPathKey = (jobId: string) => `job:${jobId}:graph_path`;

export const jobAgentsDoneKey = (jobId: string) => `job:${jobId}:agents_done`;

export const jobAgentsExpectedKey = (jobId: string) =>
  `job:${jobId}:agents_expected`;

// Fencing token for a job's current run. Incremented by JobsService.forceStop*
// so any in-flight agent message from a superseded run (stamped with the old
// epoch) is dropped by the worker instead of writing stale results or
// prematurely tripping completion tracking. Unset == generation 0.
export const jobEpochKey = (jobId: string) => `job:${jobId}:epoch`;

// A job's *run* identity: `{jobId}-{epoch}`. The orchestrator extracts each run
// to /tmp/repos/{runKey}, so a force-stop (which INCRs the epoch) produces a
// genuinely different checkout and graph. Anything scoped to the contents of a
// checkout must key on this, not on jobId alone — otherwise a retry reads the
// abandoned run's data back. Unset epoch == generation 0, matching jobEpochKey.
export const runKeyOf = (jobId: string, epoch: number | undefined) =>
  `${jobId}-${epoch ?? 0}`;

// Section 6's `agent_context:{jobId}:{agentType}:{queryHash}` — with the first
// slot widened from jobId to runKey. The cached value is derived from one
// specific checkout's graph and lives for 24h, so a bare jobId served run 1 the
// context built from run 0. See runKeyOf above.
export const agentContextKey = (
  runKey: string,
  agentType: string,
  queryHash: string,
) => `agent_context:${runKey}:${agentType}:${queryHash}`;

// Zero-LLM ground truth about a run's checkout: real routes, real module edges,
// measured complexity, framework detection, counts. Written once by the
// orchestrator after indexing, read by every agent.
//
// Not in Section 6's original table — an addition, not a rename. It follows the
// `job:{id}:graph_path` precedent (orchestrator computes, worker reads) rather
// than riding in the dispatch message, because ClientProxy copies the payload
// once per agent and the DLQ consumer parses the whole envelope for two fields.
//
// Keyed by runKey, not jobId: these facts describe one specific checkout, and
// the 24h TTL outlives the run that produced them.
export const jobRepoFactsKey = (runKey: string) => `job:${runKey}:repo_facts`;

export const jobSubmitRateLimitKey = (userId: string) =>
  `ratelimit:job_submit:${userId}`;

// Phase 4 cost cap: cumulative input+output tokens spent on a job so far.
// Checked by every agent-worker consumer *before* it calls the LLM, so once
// the shared counter crosses JOB_TOKEN_BUDGET, agents still in the queue
// short-circuit instead of spending more — not a mid-call abort, but a
// same-effect stop for a parallel orchestrator-worker design.
export const jobTokensUsedKey = (jobId: string) => `job:${jobId}:tokens_used`;

// Claimed via SET NX before synthesis runs. Only matters if the synthesizer
// is ever scaled beyond 1 replica — every replica psubscribes the same
// pattern, so without a claim two replicas would both fire the Sonnet call
// and race to write the report for the same job.
export const jobSynthesizingLockKey = (jobId: string) =>
  `job:${jobId}:synthesizing`;

// ── Pub/sub channels (not persisted keys, so not part of the Section 6 table) ──

// Published by agent-worker once SCARD(agents_done) reaches agents_expected;
// synthesizer subscribes with psubscribe('job:*:ready_for_synthesis').
export const jobReadyForSynthesisChannel = (jobId: string) =>
  `job:${jobId}:ready_for_synthesis`;

// Generic lifecycle event relay so api-gateway's Socket.io gateway (the only
// process holding a socket connection, per Section 4) can emit job:status /
// job:progress / job:complete even though the event originates in another
// process (orchestrator, agent-worker, synthesizer).
export const jobEventsChannel = (jobId: string) => `job:${jobId}:events`;
