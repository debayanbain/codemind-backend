# Project: AI Repo Analyzer — Multi-Agent Codebase Report Generator

## Read this entire file before writing any code. Do not deviate from the architecture below without asking first — it was deliberately scoped for a 2-4 day build and for interview defensibility. Do not add features not listed here.

---

## 1. What this project is

A web platform where a user logs in with GitHub, selects a repo, and the system runs a
multi-agent pipeline that analyzes the codebase and produces a report (architecture,
security, dependencies, code quality, docs) with D2 diagrams, exportable as
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
- **Diagrams**: `@terrastruct/d2` (npm package, used programmatically as a library — NOT the `d2` CLI). Rendered to SVG **server-side in the synthesizer**, never in the browser.
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
6. `agent-worker` has one queue bound per routing key, `prefetch: 3` each (see
   Section 11 — this was 1, and the stated rationale was backwards). On each
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
   - Builds all six diagrams from the agent JSON and renders each to SVG (D2 via
     WASM, plus two hand-built charts — see Section 9). Zero LLM calls. Runs
     after the Sonnet call because the health gauge needs its score.
   - Renders the final Markdown report (agent JSON -> Markdown sections ->
     diagram fences carrying each diagram's source).
   - Persists Markdown + rendered SVGs to `reports` table.
   - Updates job status to `done`, emits Socket.io `job:complete`.
8. Frontend polls `GET /jobs/:id` (or listens on the socket) and renders the report.
   The response carries `report.markdownContent` + `report.diagrams[]`; the frontend
   splices the SVGs in with the same `inlineDiagrams()` helper the exporter uses.
   **No diagram library runs client-side** — the browser only embeds strings.
9. Export: `GET /jobs/:id/export?format=md|pdf` (see Section 10). Do not
   pre-generate PDFs for every job.

## 6. Redis key schema (implement exactly this, don't invent your own naming)

| Key | Type | Purpose |
|---|---|---|
| `job:{id}:status` | string | `pending`\|`running`\|`done`\|`failed` |
| `job:{id}:graph_path` | string | path to the SQLite CodeGraph DB for this job |
| `job:{id}:agents_done` | set | which agent types have completed |
| `job:{id}:agents_expected` | int (or set) | which agents orchestrator dispatched, to know when synthesizer should fire |
| `agent_context:{runKey}:{agentType}:{queryHash}` | string (JSON) | cached `buildContext` result, TTL 24h |
| `job:{runKey}:repo_facts` | string (JSON) | zero-LLM AST ground truth for this run, TTL 24h |
| rate limit key per user | string w/ TTL | cap job submissions per user per time window |

**`runKey` = `{jobId}-{epoch}`.** Anything scoped to the *contents of a checkout*
must key on the run, not the job. A force-stop `INCR`s `job:{id}:epoch` and the
orchestrator extracts a genuinely different checkout to `/tmp/repos/{runKey}`;
with a bare jobId and a 24h TTL, run 1 read back run 0's abandoned data and
nothing ever errored. Keys about the *job* (status, completion, budget, epoch)
stay keyed by jobId — those legitimately span runs.

`job:{runKey}:repo_facts` is an addition to this table, not a rename. It follows
the `graph_path` precedent — orchestrator computes, workers read — rather than
riding in the dispatch message, because `ClientProxy` copies the payload once per
agent and the DLQ consumer parses the whole envelope to read two fields.

## 7. Postgres schema

```
users(id, github_id, github_access_token_encrypted, created_at)
jobs(id, user_id, repo_full_name, status, created_at, completed_at)
agent_results(id, job_id, agent_type, raw_output jsonb, tokens_used, status, created_at)
reports(id, job_id, markdown_content, diagrams jsonb, created_at)
```

Token usage per agent run is mandatory, not optional — this is your answer to "how do
you control LLM cost in production," and it's how you avoid a runaway bill during a
live demo.

## 8. Agent design — a bounded evidence loop per agent

> **Superseded (approved deviation).** This section originally specified one
> `buildContext` call and one LLM call per agent. That is why the reports read
> like a filled-in form: an agent got 20 nodes chosen before it had seen
> anything, and could not ask a single follow-up about code it had just read.
> Each agent is now a **bounded tool-use loop** over the code graph. The
> per-agent seed queries below still apply — they're the loop's starting point,
> not its only input.
>
> **This is not a ReAct chain across agents, and the distinction is the point.**
> The five analyses stay independent and still fan out over the topic exchange;
> nothing security learns changes what docs should look at. What changed is
> *inside* one agent, where the work genuinely is sequential-with-feedback.
>
> The loop is hand-rolled (~120 lines in `base.agent.ts`) — not the SDK's Tool
> Runner, not a framework. Section 2's ban stands.
>
> Mechanics that are load-bearing:
> - **Tools are read-only** and every result carries `file:line`. A claim the
>   agent can't point at is a claim the report can't make.
> - **A throwing tool is not a failure** — it returns `is_error: true` and the
>   model recovers. Killing a run over a bad node id would discard every turn
>   already paid for.
> - **All parallel tool results go back in ONE user message.** Splitting them
>   silently trains the model out of parallel calls.
> - **Turn and token caps, with a forced finish.** On the last affordable turn
>   the `emit_*` tool is forced, so "out of turns" and "out of budget" both yield
>   a real if narrower analysis (marked `truncated`) instead of nothing.
> - **The fence is re-checked every turn** (`EpochFencedError`), because a
>   force-stop mid-loop otherwise burns minutes of tokens on an abandoned run.
> - **Facts before search.** Anything the AST already knows arrives from the
>   RepoFacts pre-pass (Section 6). The loop is for what the AST *can't* say.

Each agent gets a targeted seed query so its first turn starts somewhere useful:

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

## 9. D2 diagram generation — must be data-driven, not LLM-generated

The LLM never writes diagram syntax. Pure-TypeScript builders map agent JSON to
D2 source, which is then rendered to SVG. This is how you guarantee diagrams
reflect real code relationships instead of hallucinated ones, and it's the answer
to "how do you know the diagrams are accurate" in interview.

Six diagrams, one function each, in `apps/synthesizer/src/diagrams/`:

| # | Diagram | Built by | From |
|---|---|---|---|
| 1 | `moduleGraph()` | `d2-source.builder.ts` | architecture agent's `module_dependencies[]` |
| 2 | `sequenceDiagram()` | `d2-source.builder.ts` | architecture agent's `request_flows[].steps[]` |
| 3 | `securityFlow()` | `d2-source.builder.ts` | security agent's `auth_flow_steps[]` + `vulnerabilities[]` |
| 4 | `dependencyGraph()` | `d2-source.builder.ts` | dependency agent's runtime deps, flagged critical/outdated |
| 5 | `qualityDonut()` | `chart-svg.builder.ts` | quality agent's `issues[].category`, bucketed and counted |
| 6 | `healthGauge()` | `chart-svg.builder.ts` | the synthesis call's `overallHealthScore` |

**Why the last two aren't D2.** D2 is a diagram language, not a charting library
— it has no pie, donut, or gauge primitive. Rather than abuse box shapes to fake
one, the two purely quantitative visuals are emitted as hand-built SVG. Same
guarantees as the D2 path: rendered once, server-side, inert markup.

**Rendering rules (`d2-renderer.service.ts`):**
- One `D2` WASM instance, lazily booted, reused for the process lifetime.
- **Every call goes through a mutex.** `@terrastruct/d2` tracks exactly one
  in-flight request per instance (a single `currentResolve` field), so two
  concurrent `compile()` calls make the first hang forever and the second
  resolve with the first's result. The library has no queue of its own.
- On timeout the instance is **destroyed, not reused** — a late worker reply
  would otherwise resolve the *next* diagram's promise with this one's SVG.
- A diagram that fails to render degrades to a visible placeholder. It never
  fails the job: the agent tokens are already spent.
- Labels come from LLM output, so they are sanitized (quotes/backslashes
  stripped, length-capped) and node ids are prefixed + collision-counted so
  `src/auth` and `src.auth` can't silently merge into one node.

**Accessibility rules, applied to all six:** risk is encoded as a text prefix
(`[CRITICAL]`, `HEALTHY`) *in addition to* colour, never colour alone; the
palette is Okabe-Ito derived (colourblind-safe); charts carry `role="img"` +
`<title>`/`<desc>`; every chart value is directly labelled. All of this also
means the diagrams survive greyscale printing.

`@terrastruct/d2` is **ESM-only** — its advertised CommonJS build sets
`module.exports` inside a `"type": "module"` package and throws on `require()`.
Load it with a dynamic `import()`. Our `tsconfig` uses `module: nodenext`, which
preserves that as a real `import()` in the CJS output instead of downlevelling
it to `require()`. Do not change `module` to `commonjs`.

Its `.d.ts` also lies about `compile()`'s second argument: the types say
`{ options: CompileOptions }`, the runtime reads the options off the top level.
Pass them flat — the nested form compiles clean and then silently ignores
`layout`, so everything lays out with `dagre`.

## 10. Export pipeline detail

Diagrams arrive at the exporter **already rendered to SVG**. The stored Markdown
carries only each diagram's *source*, tagged with its slug:

````
```d2 architecture-modules
direction: right
m_api -> m_db
```
````

The SVGs live beside it in `reports.diagrams` (jsonb). `inlineDiagrams()` in
`@app/common` swaps each fence for its `<figure><svg>…</figcaption></figure>`.

- `.md` — serve the stored Markdown directly. It keeps the D2/chart source, so
  it stays a readable, diffable text document (a 20KB base64 SVG blob is not),
  and the report remains re-renderable if the diagram style ever changes.
- `.pdf` — `inlineDiagrams()` → `md-to-pdf`. **No CDN script, no client-side JS,
  no network access.** The old Mermaid path injected `mermaid.esm.min.mjs` from
  a CDN and relied on Puppeteer executing it before capture, which meant an
  export silently emitted raw code blocks whenever the CDN was slow, blocked, or
  the capture won the race. That entire class of failure is gone.

Puppeteer still needs Chromium for the Markdown→PDF step — in Docker:

```dockerfile
RUN apt-get install -y chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

Only `synthesizer` needs `@terrastruct/d2` at runtime (~58MB of WASM); the
Dockerfile prunes it from the other three images. `api-gateway` embeds SVG the
synthesizer already produced — it needs the strings, not the renderer.

## 11. RabbitMQ config

- One topic exchange: `agents.topic`
- Routing keys: `agent.architecture`, `agent.security`, `agent.dependencies`, `agent.quality`, `agent.docs`
- One queue per agent type, bound to its routing key, `prefetch: 3`. **Corrected:**
  this said `prefetch: 1`, "so one slow LLM call doesn't block other messages of
  the same type from other jobs". It does the opposite — one unacked message per
  consumer is exactly that blocking, and job B waits for job A to ack. Invisible
  at 5s per agent; minutes of dead air now that an agent is a tool loop. 3 is safe
  because the loop is I/O-bound on the LLM; not higher, because each in-flight
  agent holds a graph handle and a growing conversation, and unacked messages are
  re-run on a crash.
- Heartbeat pinned at 30s on every AMQP connection. CodeGraph reads are synchronous
  and share amqplib's event loop; a long sync run misses beats, drops the
  connection, and gets the message redelivered — 3x the tokens and still a failure.
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
- "The fan-out isn't a loop; each agent is. Different axes. The five analyses are
  independent, so they fan out over a topic exchange rather than chaining — but
  inside one agent the work is exactly sequential-with-feedback, because you
  can't know which symbol to read next until you've read the last one. So each
  agent is a bounded evidence loop over the graph, and the dispatch between them
  still isn't."
- "One agent-worker process with multiple queue consumers, not five separate
  microservices — decoupled via RabbitMQ routing keys, but doesn't need independent
  deployment/scaling at this project's scale."
- "Token usage is tracked per agent run in Postgres specifically so cost is
  measurable and cappable, not just 'trust me it's cheap.'"
- "Diagrams are generated in plain TypeScript, not written by the LLM. The module
  graph is built from `getFileDependencies` aggregated to module level — real
  imports, weighted — so it can't express an edge that isn't in the code. Worth
  being precise here: that was *aspirational* until the RepoFacts pre-pass landed,
  because diagram #1 was drawn from an LLM-invented `module_dependencies[]`. The
  claim is only true because the facts moved out of the model."
- "Anything the AST already knows, the model never gets asked. Framework, entry
  points, routes, module edges, complexity hotspots, cycles, dead code — all
  computed once, zero LLM, and handed to the agents as ground truth. A fact the
  graph has is a fact a model shouldn't be invited to guess at."
- "I render D2 to SVG server-side, at report-build time. Mermaid only renders in
  a browser, so the PDF exporter had to inject a CDN script and hope Puppeteer
  executed it before capture — a race that fails silently into raw code blocks.
  Now the SVG is inert: the PDF path and the frontend both just embed a string,
  and neither needs a diagram library or network access."
- "The stored Markdown keeps the diagram *source*, not the SVG, so a `.md` export
  is still a readable text document and restyling every diagram never means
  re-running the agents."

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