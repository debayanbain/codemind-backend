# CodeMind — AI Repo Analyzer

Log in with GitHub, pick a repo, get back a multi-section report — architecture,
security, dependencies, code quality, docs — with Mermaid diagrams generated
from real code relationships, exportable as Markdown or PDF.

Portfolio project. The point isn't the report; it's the plumbing: a
message-driven multi-agent pipeline (RabbitMQ + Redis + NestJS + Socket.io)
that controls LLM cost with a pre-built code graph instead of dumping raw
files at the model.

## Architecture

```
                    ┌──────────────┐
  Browser ────────▶ │ api-gateway  │  GitHub OAuth, repo listing, trigger
                    │ (HTTP + WS)  │  endpoint, report/export, Socket.io
                    └──────┬───────┘
                           │ analysis.requested (direct queue)
                           ▼
                    ┌──────────────┐
                    │ orchestrator │  tarball download, CodeGraph index,
                    │              │  manifest-based agent selection
                    └──────┬───────┘
                           │ agents.topic (topic exchange, 5 routing keys)
                           ▼
                    ┌──────────────┐
                    │ agent-worker │  1 process, 5 queue consumers:
                    │              │  architecture / security / dependency /
                    │              │  quality / docs — Haiku, prefetch:1 each
                    └──────┬───────┘
                           │ Redis pub/sub: job:*:ready_for_synthesis
                           ▼
                    ┌──────────────┐
                    │ synthesizer  │  1 Sonnet call, Mermaid builder,
                    │              │  Markdown renderer
                    └──────────────┘

  Postgres: users, jobs, agent_results, reports
  Redis:    job status/progress, CodeGraph context cache, rate limits
```

Four NestJS apps in one monorepo (`apps/`), not five independently deployed
microservices for the five agents — they share runtime dependencies and don't
need independent scaling at this project's scale. One `agent-worker` process
with five queue consumers is the defensible middle ground between "one giant
monolith" and "five services nobody needed to split."

## Data flow

1. `GET /auth/github` → GitHub OAuth → `api-gateway` encrypts the access token
   (AES-256-GCM) and stores it, issues an httpOnly JWT cookie.
2. `GET /repos` lists the user's GitHub repos.
3. `POST /analyze/:repoId` creates a `jobs` row (`pending`), publishes
   `analysis.requested`, returns `jobId` immediately (202-style, not a blocking call).
4. `orchestrator` downloads the repo via GitHub's tarball API (never `git
   clone` — no git binary dependency), runs `CodeGraph.init()` +
   `indexAll()` (pure AST parsing, zero LLM cost), builds a file manifest to
   decide which agents are relevant, and fans out one message per agent type
   onto the `agents.topic` exchange.
5. `agent-worker` runs a role-specific `buildContext()` query per agent (see
   below), checks the Redis context cache, calls Haiku with a strict JSON
   schema, writes to `agent_results`, and tracks completion in Redis.
6. Once every dispatched agent has finished, `synthesizer` pulls all agent
   results, builds six Mermaid diagrams programmatically (zero LLM calls),
   makes one Sonnet call for cross-agent reasoning, renders the Markdown
   report, and persists it.
7. Socket.io relays `job:status` / `job:progress` / `job:complete` /
   `job:failed` events to the browser — job lifecycle only, never raw agent
   reasoning.
8. `GET /jobs/:id/export?format=md|pdf` serves the stored report; PDF export
   converts Mermaid fences to Mermaid.js-rendered `<div>`s and renders via
   Puppeteer at request time (not pre-generated per job).

## Why these choices

**Why RabbitMQ, not just Redis queues or direct HTTP calls.** The pipeline is
router-worker with independent, parallelizable subtasks — a topic exchange
with per-agent routing keys is the natural fit, and `prefetch: 1` per queue
means one slow LLM call for `security` never blocks `docs` from processing
its own backlog across other jobs.

**Why Redis, beyond "it's a cache."** Three distinct jobs, one store: (1) job
status/progress state that both HTTP handlers and Socket.io need to read
without hitting Postgres on every poll, (2) atomic completion tracking —
`SADD agents_done` + `SCARD` against `agents_expected` is how agent-worker
instances (running in parallel, no shared memory) agree a job is ready for
synthesis without a distributed lock, (3) a 24h TTL cache on
`CodeGraph.buildContext()` results, keyed by job+agent+query hash, so a
re-analyzed repo or overlapping queries skip the LLM call entirely.

**Why CodeGraph instead of sending raw files to the LLM.** A tree-sitter AST
index is built once per job with zero LLM cost. Every agent then asks a
targeted semantic question (`buildContext(query, { maxNodes, includeCode })`)
and gets back only the relevant nodes, sorted by centrality — not "here's
40 files, figure it out." Token budget is enforced *before* the call
(truncate by centrality, never by raw line count), and the outcome is
measurable: `tokens_used` is logged per agent run in Postgres, not asserted.

**Why Mermaid diagrams are built in plain TypeScript, not by the LLM.** The
six diagram builders (`mermaid.builder.ts`) map agent JSON straight to
Mermaid syntax. The LLM never writes diagram syntax. That's the answer to "how
do you know the diagrams are accurate" — they can't hallucinate a dependency
edge that isn't in the agent's structured output, because there's no
generation step between the graph data and the diagram.

**Why hand-rolled orchestration, not LangChain/CrewAI.** The five analysis
subtasks are independent, not a sequential ReAct loop with feedback — a
message-driven fan-out/fan-in is a better fit than an agent framework built
for tool-calling loops, and the dispatch logic is small enough that owning it
directly is more legible than configuring someone else's abstraction around it.

## Repo layout

```
apps/
  api-gateway/     GitHub OAuth, repo listing, trigger endpoint, report/export, Socket.io gateway
  orchestrator/    RabbitMQ consumer: tarball download, CodeGraph index, agent dispatch
  agent-worker/    5 queue consumers (1 process): architecture/security/dependency/quality/docs
  synthesizer/     Completion tracking, 1 Sonnet call, Mermaid + Markdown rendering
libs/common/       Prisma service, Redis/RabbitMQ topology constants, Redis config, crypto
prisma/            schema.prisma (source of truth for the DB) + generated migrations
```

## Running locally

Postgres is Supabase, not a local container — every environment (dev and
prod) points at the same project. Redis and RabbitMQ still run locally via
Docker.

```bash
cp .env.example .env
# fill in: DATABASE_URL/DIRECT_URL (Supabase -> Project Settings -> Database),
# GITHUB_CLIENT_ID/SECRET, JWT_SECRET, SESSION_SECRET,
# TOKEN_ENCRYPTION_KEY (openssl rand -hex 32), ANTHROPIC_API_KEY

docker compose up -d redis rabbitmq   # mgmt UI on :15672
npm install                           # postinstall runs `prisma generate`
npm run prisma:migrate:deploy         # apply the schema to Supabase

npm run start:api-gateway:dev
npm run start:orchestrator:dev
npm run start:agent-worker:dev
npm run start:synthesizer:dev
```

`GET /auth/github` starts the OAuth flow; the frontend consuming this API is
still in progress (see Status below).

## Redis key schema

| Key | Type | Purpose |
|---|---|---|
| `job:{id}:status` | string | `pending`\|`running`\|`done`\|`failed` |
| `job:{id}:graph_path` | string | path to the SQLite CodeGraph DB for the job |
| `job:{id}:agents_done` | set | agent types that have completed |
| `job:{id}:agents_expected` | set | agent types the orchestrator dispatched |
| `agent_context:{jobId}:{agentType}:{queryHash}` | string (JSON) | cached `buildContext` result, TTL 24h |
| `ratelimit:job_submit:{userId}` | string w/ TTL | job submissions per user per hour |
| `job:{id}:tokens_used` | int | cumulative agent token spend, checked against `JOB_TOKEN_BUDGET` before each LLM call |
| `job:{id}:synthesizing` | string w/ TTL (NX claim) | prevents 2 synthesizer replicas racing the same job |

Completion detection: agent-worker publishes `job:{id}:ready_for_synthesis`
once `SCARD(agents_done) == SCARD(agents_expected)`; the synthesizer
`psubscribe`s `job:*:ready_for_synthesis` rather than polling. Job lifecycle
events for Socket.io are relayed the same way, via `job:{id}:events`.

## RabbitMQ topology

- `analysis.requested` — simple durable queue, api-gateway → orchestrator
- `agents.topic` — topic exchange, orchestrator → agent-worker
- Routing keys: `agent.architecture`, `agent.security`, `agent.dependencies`, `agent.quality`, `agent.docs`
- One queue per agent type bound to its routing key, `prefetch: 1` each

## Status

- [x] Phase 1 — infra, GitHub OAuth, trigger → queue → dummy consumer loop
- [x] Phase 2 — tarball download, CodeGraph indexing, manifest-based agent dispatch
- [x] Phase 3 (backend) — all 5 agents, synthesizer, Mermaid builder, report renderer
- [ ] Phase 3 (frontend) — Next.js UI (connect → pick repo → trigger → live status → report)
- [x] Phase 4 — PDF export, repo size/file-count guardrails, per-job token budget cap
- [x] Containerized — Dockerfile per app, docker-compose wiring, Prisma migrations
- [x] Prisma + Supabase — dropped local Postgres container, DB is Supabase everywhere
- [ ] Demo video

## Production

### Database: Prisma + Supabase

Postgres is a single Supabase project (`codemind`, `ap-south-1`), used by
every environment — there's no local Postgres container to keep in sync with
it. `prisma/schema.prisma` is the source of truth; `@map`/`@@map` keep the
Postgres tables/columns snake_case (`agent_results`, `raw_output`, ...)
while the generated TS client stays camelCase.

Two connection strings, both required:

```bash
DATABASE_URL   # transaction pooler, port 6543, ?pgbouncer=true — what the 4 apps use at runtime
DIRECT_URL     # session pooler, port 5432 — required by `prisma migrate`, can't run DDL through the transaction pooler
```

```bash
npm run prisma:generate        # regenerate the client after any schema.prisma change
npm run prisma:migrate:dev     # create + apply a migration locally
npm run prisma:migrate:deploy  # apply pending migrations, no prompts (what `docker-compose`'s migrate service runs)
npm run prisma:studio          # browse the DB
```

### Running the full stack in containers

`docker-compose.yml` builds and runs all 4 apps alongside Redis and
RabbitMQ (Postgres isn't a service here — it's Supabase) — one
`Dockerfile`, parameterized per app via a build arg, so the build recipe
can't drift between them:

```bash
cp .env.example .env   # fill in real secrets — see below
docker compose up -d --build
```

A `migrate` service runs `prisma migrate deploy` against Supabase and exits
before any app container starts (`depends_on: condition:
service_completed_successfully`).

`orchestrator` and `agent-worker` share a named volume at `/tmp/repos`.
They're separate containers, so without a shared volume `agent-worker`
would be looking for a repo checkout on a filesystem `orchestrator` never
wrote to — this isn't optional the way it might look in local dev, where
both happen to run on the same machine's real `/tmp`.

Only `api-gateway`'s image installs Chromium (`INSTALL_CHROMIUM: 'true'`
build arg) — it's the only app that ever calls `md-to-pdf`. The other 3
images skip the ~300MB apt install.

### Secrets

Real values belong in the platform's secret store, never committed:
`DATABASE_URL` / `DIRECT_URL` (Supabase password), `GITHUB_CLIENT_ID` /
`GITHUB_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `JWT_SECRET`,
`TOKEN_ENCRYPTION_KEY`. The GitHub OAuth callback URL needs to point at the
real domain, over HTTPS — the JWT cookie already sets `secure` based on
`NODE_ENV=production`.

### Where to actually deploy this

`api-gateway` needs a public port; `orchestrator` / `agent-worker` /
`synthesizer` don't and never receive inbound traffic — on platforms that
distinguish "web service" from "background worker" (Railway, Render, Fly),
deploy them as the latter or they'll be flagged unhealthy for never opening
a port. Postgres is already managed (Supabase); adding managed Redis/RabbitMQ
(Upstash, CloudAMQP) avoids running stateful services yourself — the cheaper
alternative is one VPS running this same `docker-compose.yml`.

### Known scaling limits

- **`synthesizer` has a Redis `SET NX` claim lock** (`job:{id}:synthesizing`)
  so running more than 1 replica doesn't double-fire the Sonnet call for the
  same job — but there's still no reason to run more than 1 today; a single
  replica isn't a bottleneck at this project's volume.
- **`GET /health`** (unauthenticated, checks Postgres + Redis connectivity)
  is what a load balancer or orchestrator should poll — add it as the
  container healthcheck if deploying somewhere that wants one.
