# Project: AI Repo Analyzer — Multi-Agent Codebase Report Generator

## Read this entire file before writing any code. Do not deviate from the architecture below without asking first — it was deliberately scoped for a 2-4 day build and for interview defensibility. Do not add features not listed here.

---

## 1. What this project is

A web platform where a user logs in with GitHub, selects a repo, and the system runs a
multi-agent pipeline that analyzes the codebase and produces a report (architecture,
security, dependencies, code quality, docs) with Mermaid diagrams, exportable as
`.md` or `.pdf`.

This is a portfolio project for interviews. Priorities in order:
1. It must actually work end-to-end (login → analyze → report → export).
2. It must demonstrate correct, defensible use of RabbitMQ, Redis, NestJS, Socket.io.
3. It must control LLM token cost via a code graph (not raw file dumps).
4. Polish and extra features are last priority — do not build them before 1-3 are solid.

## 2. Explicit non-goals (do NOT build these, even if it seems easy)

- No actually running/building/executing the target repo's code.
- No full AST-based static analysis beyond what CodeGraph gives us for free.
- No multi-tenant billing, teams, org-wide repo support.
- No WebSocket streaming of raw agent "thoughts" — Socket.io is only for job status
  and progress updates (see Section 6).
- No support for every language — hard-cap to JS/TS/Python/Go. Anything else:
  degrade gracefully ("language not supported for deep analysis") rather than error.
- No LangChain, CrewAI, or any agent framework. Hand-roll the orchestrator/worker
  dispatch — that IS the interview signal, do not outsource it to a library.
- No distributed lock libraries (Redlock etc.) anywhere in this project.
- Do not pre-analyze repos on OAuth login — only on explicit user-triggered "Analyze" action.

## 3. Tech stack (fixed, do not substitute)

- **Backend**: NestJS (monorepo using Nest's built-in workspace support, `apps/` folder)
- **Queue**: RabbitMQ (topic exchange)
- **Cache/state**: Redis
- **DB**: PostgreSQL
- **Realtime**: Socket.io (job status/progress only)
- **Code graph**: `@colbymchenry/codegraph` (npm package, used programmatically — NOT the MCP server, NOT the CLI)
- **LLM**: Anthropic API — Haiku for parallel extraction agents, Sonnet for the single synthesis call
- **PDF export**: `md-to-pdf` (Puppeteer under the hood)
- **Frontend**: Next.js, minimal — one flow: connect GitHub → pick repo → trigger analysis → poll/see live status → view report → export

## 4. Service architecture

Build as a NestJS monorepo, `apps/` folder, one repo, NOT separate repos:

```
apps/
  api-gateway/       # GitHub OAuth, repo listing, trigger endpoint, report/export endpoints, Socket.io gateway
  orchestrator/      # RabbitMQ consumer: analysis.requested -> downloads repo, builds CodeGraph index, dispatches to agents
  agent-worker/      # ONE service, multiple consumers bound to routing keys (agent.architecture, agent.security, agent.dependencies, agent.quality, agent.docs)
  synthesizer/       # Consumes agent results, waits for completion via Redis, runs single Sonnet call, renders Markdown + Mermaid, persists report
```

Do NOT create 5 separate microservices for the 5 agents. One `agent-worker` process
with multiple queue consumers is the correct pattern here — cheaper to run, still a
legitimate message-driven multi-agent design, and is what you defend in interview as
"orchestrator-worker, not 5 independently deployed services, because the agents share
runtime dependencies and don't need independent scaling for this project's scale."

## 5. Data flow (end to end)

1. User logs in via GitHub OAuth (Passport GitHub strategy) in `api-gateway`.
2. `api-gateway` lists user's repos via GitHub API.
3. User picks a repo, hits `POST /analyze/:repoId`.
4. `api-gateway` creates a `jobs` row (status=`pending`), publishes `analysis.requested`
   to RabbitMQ, returns `jobId` immediately.
5. `orchestrator` consumes `analysis.requested`:
   - Downloads repo via GitHub tarball endpoint (NOT git clone — no git binary dependency).
   - Extracts to `/tmp/repos/{jobId}`.
   - Runs `CodeGraph.init()` + `cg.indexAll()` — pure AST parsing, **zero LLM calls**.
   - Writes SQLite graph path to Redis: `job:{id}:graph_path`.
   - Builds a file manifest (path, size, ext) to decide which agents are even relevant
     (e.g. no `Dockerfile` → skip container-security checks inside the security agent).
   - Publishes one message per relevant agent type to topic exchange `agents.topic`
     with routing keys `agent.architecture`, `agent.security`, `agent.dependencies`,
     `agent.quality`, `agent.docs`.
   - Updates job status to `running`, emits Socket.io `job:status` event.
6. `agent-worker` has one queue bound per routing key, `prefetch: 1` each. On each
   message:
   - Reads `job:{id}:graph_path` from Redis, opens the SQLite DB read-only (WAL mode
     allows concurrent reads).
   - Runs a **role-specific** `cg.buildContext(query, opts)` call (see Section 7 for
     exact queries per agent — do not use a generic/shared query for all agents).
   - Checks Redis cache first: `agent_context:{jobId}:{agentType}:{hash(query)}` —
     if present, skip the LLM call entirely.
   - Calls Haiku with a strict JSON output schema for that agent type.
   - Validates the JSON shape before writing. If malformed: catch, log, mark that
     agent as `failed` in Postgres, do NOT crash the job — synthesizer proceeds with
     whatever agents succeeded.
   - Writes result to `agent_results` table.
   - `SADD job:{id}:agents_done {agentType}` in Redis.
   - Emits Socket.io `job:progress` event (e.g. "3 of 5 agents complete").
7. `synthesizer` listens for `agents_done` reaching expected count (check via `SCARD`
   after each `SADD`, or a lightweight poll — your choice, document which you pick).
   - Pulls all `agent_results` rows for the job.
   - One single Sonnet call: reasons across all agent outputs, produces an overall
     health score and any cross-cutting findings.
   - Renders the final Markdown report (agent JSON -> Markdown sections -> Mermaid
     diagrams built programmatically, see Section 8).
   - Persists to `reports` table.
   - Updates job status to `done`, emits Socket.io `job:complete`.
8. Frontend polls `GET /jobs/:id` (or listens on the socket) and renders the report.
9. Export: `GET /jobs/:id/export?format=md|pdf`
   - `.md` — serve the stored markdown string directly.
   - `.pdf` — at request time, replace ` ```mermaid ` fences with `<div class="mermaid">`
     tags, inject Mermaid.js via CDN into an HTML wrapper, render with `md-to-pdf`
     (Puppeteer executes the injected JS before capture, so diagrams actually render,
     not just show as code blocks). Do not pre-generate PDFs for every job.

## 6. Redis key schema (implement exactly this, don't invent your own naming)

| Key | Type | Purpose |
|---|---|---|
| `job:{id}:status` | string | `pending`\|`running`\|`done`\|`failed` |
| `job:{id}:graph_path` | string | path to the SQLite CodeGraph DB for this job |
| `job:{id}:agents_done` | set | which agent types have completed |
| `job:{id}:agents_expected` | int (or set) | which agents orchestrator dispatched, to know when synthesizer should fire |
| `agent_context:{jobId}:{agentType}:{queryHash}` | string (JSON) | cached `buildContext` LLM result, TTL e.g. 24h |
| rate limit key per user | string w/ TTL | cap job submissions per user per time window |

## 7. Postgres schema

```
users(id, github_id, github_access_token_encrypted, created_at)
jobs(id, user_id, repo_full_name, status, created_at, completed_at)
agent_results(id, job_id, agent_type, raw_output jsonb, tokens_used, status, created_at)
reports(id, job_id, markdown_content, created_at)
```

Token usage per agent run is mandatory, not optional — this is your answer to "how do
you control LLM cost in production," and it's how you avoid a runaway bill during a
live demo.

## 8. Agent design — exact per-agent CodeGraph queries

Do not give every agent the same `buildContext` call. Each agent gets a targeted
semantic query so its LLM call only sees relevant code:

- **Architecture agent**: `buildContext('entry points main module bootstrap dependency injection controllers services', { maxNodes: 15, includeCode: true })` + `cg.files()` for directory structure (no LLM cost). Output includes `module_dependencies[]` (from/to pairs) and `request_flows[]` (ordered steps) — these feed Mermaid diagrams directly.
- **Security agent**: `cg.searchNodes('auth jwt token password hash encrypt')` → `cg.getCallers(...)` on top hits → `buildContext('authentication authorization input validation sql injection user input', { maxNodes: 15, includeCode: true })`. Output includes `auth_flow_steps[]` and `vulnerabilities[]`.
- **Dependency agent**: read `package.json`/`requirements.txt` directly (small, no graph needed) + `buildContext('external imports third party libraries', { maxNodes: 10 })`. Consider skipping the LLM entirely here — parse manifest files programmatically and flag outdated/critical deps in code. Zero LLM cost is a valid, defensible choice.
- **Code quality agent**: `buildContext('error handling exception try catch async await promise rejection', { maxNodes: 15, includeCode: true })` + `cg.getImpactRadius(nodeId)` for coupling signal (no LLM cost). Output includes `issues[]` bucketed by category — feeds the quality pie chart.
- **Docs agent**: read README directly from filesystem (always small) + `buildContext('public export interface type definition API contract', { maxNodes: 12, includeCode: true })`.

Enforce a **hard token budget** before any LLM call: `maxNodes` capped, and if context
exceeds budget, truncate by node centrality (most-called symbols first), never by
raw line count.

Model routing: Haiku for architecture/security/quality/docs agents. Dependency agent:
prefer zero-LLM parsing. Synthesis: exactly one Sonnet call, never more.

## 9. Mermaid diagram generation — must be data-driven, not LLM-generated

Build a `mermaid.builder.ts` module that is pure TypeScript — it maps agent JSON
output to Mermaid syntax. The LLM never writes Mermaid syntax directly. This is
important: it's how you guarantee diagrams reflect real code relationships instead
of hallucinated ones, and it's the answer to "how do you know the diagrams are
accurate" in interview.

Six diagrams, one function each:
1. `moduleGraph()` — from architecture agent's `module_dependencies[]`
2. `sequenceDiagram()` — from architecture agent's `request_flows[].steps[]`
3. `securityFlow()` — from security agent's `auth_flow_steps[]` + `vulnerabilities[]`
4. `dependencyGraph()` — from dependency agent's runtime deps, flag critical/outdated
5. `qualityPie()` — from quality agent's `issues[].category`, bucketed and counted
6. `healthGauge()` — from the synthesis call's `overallHealthScore`

## 10. Export pipeline detail

In the PDF export controller: replace ` ```mermaid ... ``` ` fences with
`<div class="mermaid">...</div>`, wrap the whole markdown-to-HTML output in a page
that includes the Mermaid ESM script tag from a CDN, then pass to `md-to-pdf`.
Puppeteer must have Chromium available — in Docker:

```dockerfile
RUN apt-get install -y chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

## 11. RabbitMQ config

- One topic exchange: `agents.topic`
- Routing keys: `agent.architecture`, `agent.security`, `agent.dependencies`, `agent.quality`, `agent.docs`
- One queue per agent type, bound to its routing key, `prefetch: 1` (so one slow LLM
  call doesn't block other messages of the same type from other jobs)
- Separate simple queue for `analysis.requested` -> orchestrator
- Separate queue/event for `report.ready` if synthesizer and api-gateway are decoupled

## 12. Build order — follow these phases strictly, in order, do not skip ahead

**Phase 1 (get this fully working before anything else):**
- Docker Compose: Postgres, Redis, RabbitMQ running locally.
- NestJS monorepo scaffold with the 4 apps.
- GitHub OAuth end-to-end: login, list repos.
- `POST /analyze/:repoId` that just enqueues a message; a dummy consumer that logs
  receipt. No CodeGraph, no LLM calls yet.
- Verify: trigger from frontend/Postman → message appears in RabbitMQ → consumer logs it → job status updates in Postgres/Redis → Socket.io event fires.
- Do not proceed to Phase 2 until this loop works. This is the riskiest integration surface in the whole project.

**Phase 2:**
- Tarball download + extraction.
- CodeGraph integration: `init()` + `indexAll()`, confirm SQLite DB is created and queryable.
- Orchestrator dispatch logic (manifest-based agent selection).
- First 2 agents (architecture, dependencies — least LLM reasoning needed) working
  with real Haiku calls, writing to Postgres.

**Phase 3:**
- Remaining 3 agents (security, quality, docs).
- Synthesizer: completion tracking via Redis, single Sonnet synthesis call.
- Markdown template rendering + Mermaid builder module.
- Minimal Next.js frontend: connect → pick repo → trigger → poll/socket status → view report.

**Phase 4:**
- PDF export (Mermaid injection + Puppeteer).
- Guardrails: cap file count/total repo size, reject oversized repos gracefully.
- Per-job cost caps (track tokens_used, hard-stop if a job exceeds a threshold).
- Record a demo video.
- Write README documenting the architecture decisions in this file — especially the
  "why RabbitMQ," "why Redis atomic ops / caching," and "why CodeGraph instead of
  raw file reads" reasoning, since that's your actual interview material.

## 13. Things to say out loud when asked in interview (keep these accurate, don't overstate)

- "I didn't send full files to the LLM. I pre-built a code knowledge graph via
  tree-sitter AST parsing — zero LLM cost — then agents queried it with targeted
  semantic questions and got back only relevant nodes."
- "I used orchestrator-worker instead of a ReAct loop because the five analysis
  subtasks are independent, not sequential-with-feedback."
- "One agent-worker process with multiple queue consumers, not five separate
  microservices — decoupled via RabbitMQ routing keys, but doesn't need independent
  deployment/scaling at this project's scale."
- "Token usage is tracked per agent run in Postgres specifically so cost is
  measurable and cappable, not just 'trust me it's cheap.'"
- "Mermaid diagrams are generated from structured agent JSON in plain TypeScript,
  not written by the LLM, so they can't hallucinate relationships that don't exist
  in the code."

---

## Instructions to Claude Code specifically

- Work phase by phase per Section 12. After finishing a phase, stop and report what
  was built and what you verified, before starting the next phase.
- If something in this spec is ambiguous, ask before inventing your own design —
  do not silently deviate from the Redis key names, RabbitMQ routing keys, or table
  schemas above.
- Write a `docker-compose.yml` first, in Phase 1, before any app code.
- Do not install LangChain, CrewAI, or any agent orchestration framework.
- Do not use `git clone` for fetching the target repo — use GitHub's tarball API.
- Encrypt GitHub access tokens at rest, never store plaintext.
- Keep the frontend minimal — this is not a design portfolio piece, functionality
  and correctness matter far more than UI polish.