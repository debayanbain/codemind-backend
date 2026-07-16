# CodeMind — Backend Architecture

**NestJS monorepo · 4 services · main @ 1f95052**

A message-driven pipeline that turns a GitHub repository into an architecture report. Five agents read a pre-built code graph instead of raw files, one synthesis call reasons across them, and every diagram is drawn from structured JSON by plain TypeScript — never by the model.

| Metric | Value |
|---|---|
| Files indexed | 81 |
| Graph nodes | 849 |
| Graph edges | 1,466 |
| Lines of TS | 6,287 |
| Routes | 23 |
| Agents | 5 |

*Counts from the project's own CodeGraph index — the same AST parse the agents query.*

---

## Thesis: the whole design exists to control token cost

The naive version of this product dumps files into a model and pays for it. CodeMind never does that. The orchestrator runs a tree-sitter AST parse over the downloaded repo and builds a SQLite knowledge graph — **zero LLM calls**. Agents then ask that graph targeted semantic questions and get back only the nodes that matter, capped at 20 per query and 12,000 input tokens per agent.

Everything else follows from that decision. The agents are independent, so they fan out over RabbitMQ rather than looping. Their output is structured JSON, so diagrams can be built from it deterministically. Token spend is written to Postgres per run, so the claim "this is cheap" is a query, not a promise.

> **Deliberate non-goal.** No LangChain, no CrewAI, no agent framework. The orchestrator/worker dispatch is hand-rolled because that dispatch *is* the engineering signal — outsourcing it to a library would delete the interesting part of the project.

---

## Services: four processes, one repository

A NestJS monorepo with four deployables and a shared `libs/common`. Note that **the five agents are not five services** — they are five queue consumers inside one `agent-worker` process, because they share runtime dependencies and don't need independent scaling at this size.

| Service | Transport | Responsibility | LOC |
|---|---|---|---|
| `api-gateway` | HTTP + WS | GitHub OAuth, repo listing, job trigger, share links, export, Socket.io relay. The only app with a port. | 1,551 |
| `orchestrator` | AMQP | Downloads the tarball, builds the CodeGraph index, reads the manifest, decides which agents to dispatch. | 689 |
| `agent-worker` | AMQP ×5 | Five `@EventPattern` consumers, each its own channel and its own `prefetch: 1`. | 939 |
| `synthesizer` | Redis pub/sub | One Sonnet call, six diagrams, Markdown render, persist. No HTTP, no AMQP — an application context only. | 1,852 |
| `libs/common` | — | Prisma, key constants, AMQP/Redis factories, token encryption, LLM client, SVG sanitizing. | 1,256 |

---

## Data flow: request to report, end to end

This is the one genuinely ordered thing in the system, so it's the one place numbered steps carry information rather than decoration.

**1. api-gateway — Job accepted, returned immediately**
`POST /analyze/:repoId` validates `owner/repo`, checks a Redis rate-limit window, writes a `pending` job row, publishes `analysis.requested`, and hands back a `jobId`. Nothing blocks on analysis.

**2. orchestrator — Tarball in, no git binary**
Streams GitHub's tarball endpoint into `/tmp/repos/{jobId}-{epoch}` and extracts with `strip: 1`. Guarded at 200 MB and 5,000 files, so an oversized repo is rejected rather than discovered later.

**3. orchestrator — Code graph built, zero LLM cost**
`CodeGraph.init()` then `indexAll()`. The SQLite path lands in `job:{id}:graph_path`. This is the step that makes every later token cheap.

**4. orchestrator — Agents selected from the manifest**
Architecture, security, quality and docs always dispatch. Dependency only dispatches if a manifest file (`package.json`, `go.mod`, `requirements.txt`…) actually exists — no manifest, no point paying for the agent.

**5. agent-worker — Fan-out over a topic exchange**
One message per agent to `agents.topic`. Each consumer opens the graph read-only (WAL makes concurrent reads safe), checks the epoch fence, checks the Redis context cache, then calls the model and validates the reply against that agent's schema before it is allowed anywhere near the database.

**6. agent-worker — Result recorded, progress emitted**
Row into `agent_results` with tokens used, `SADD job:{id}:agents_done`, publish `job:progress`. A malformed reply marks that one agent failed — it never crashes the job.

**7. synthesizer — One Sonnet call, then six diagrams**
Claims the job with `SET NX EX 300` so a second instance can't double-spend, loads the latest result per agent type, fails the job outright if zero agents succeeded, and reasons once across all of them. Diagrams render *after*, because the health gauge needs the score.

**8. synthesizer — Markdown + SVG persisted**
The report stores diagram *source* in the Markdown and the rendered SVG beside it in `reports.diagrams`. Status flips to `done`, `job:complete` fires, the gateway relays it to the browser.

---

## Agents: five roles, five different questions

Every agent runs Sonnet 4.6 (`claude-sonnet-4-6`, overridable via `ANTHROPIC_AGENT_MODEL`) with a 1,500-token output cap — 2,600 for architecture, which is asked for a fuller structural map. None of them share a query: a generic shared context would defeat the whole point of the graph. Queries live centrally in `agent.consumer.ts`; prompts live on each agent class.

> **Model routing is the open cost question.** The original split — Haiku for extraction, Sonnet for synthesis — is the cheaper story and the better interview line. It was collapsed to all-Sonnet deliberately, to establish how deep the reports *can* go before tuning cost back down. The model is per-agent config precisely so quality and docs can move back to Haiku 4.5 once depth is proven. Note Sonnet 4.6 does not support structured outputs, so schema conformance is enforced by our own validator rather than guaranteed by the API; Sonnet 5 and Haiku 4.5 both support `strict`, and the schema is already emitted in the shape strict wants.

| Agent | Extra context | Produces | CodeGraph query |
|---|---|---|---|
| Architecture | file tree (200 files) | Modules, responsibilities, request flows | `entry point main module bootstrap controller service provider dependency injection` |
| Security | Dockerfile presence | Auth flow steps, vulnerabilities by severity | `authentication authorization guard jwt token password hash input validation user request` |
| Dependency | raw manifest | Runtime deps flagged outdated/critical. The only skippable agent. | `import require external library package third party module` |
| Quality | — | Issues bucketed by category — input to the donut | `error handling exception try catch async await promise rejection type any unknown` |
| Docs | README (8k cap) | Public API surface, doc coverage | `export public interface type definition API contract decorator description` |
| **Synthesis** | — | Health score, exec summary, cross-cutting findings | reads all `agent_results` — never the repo |

---

## Messaging: topology, and what happens when it fails

One topic exchange, `agents.topic`, five bound queues, plus a plain `analysis.requested` queue for the orchestrator. Every queue is a **quorum queue** with `x-delivery-limit: 3` and a dead-letter exchange. Topology is asserted idempotently at boot by both the orchestrator and the worker, before either starts consuming.

| Routing key | Queue | Dead letters to |
|---|---|---|
| `agent.architecture` | `agent.architecture.queue` | `dead-letter.agent.architecture` |
| `agent.security` | `agent.security.queue` | `dead-letter.agent.security` |
| `agent.dependencies` | `agent.dependencies.queue` | `dead-letter.agent.dependencies` |
| `agent.quality` | `agent.quality.queue` | `dead-letter.agent.quality` |
| `agent.docs` | `agent.docs.queue` | `dead-letter.agent.docs` |
| — (direct) | `analysis.requested` | `dead-letter.analysis` |

> **Sharp edge.** The DLQ consumers use raw `amqplib`, not `@EventPattern`. A dead-lettered message keeps its original routing pattern, so a Nest pattern consumer on the DLQ would re-match it and re-run the work that just failed three times.
>
> Also note `agent.dependencies` is plural while the enum member is `dependency`. The frontend has to translate that on every progress event.

**Why prefetch is 3, not 1.** It was 1, justified as keeping head-of-line blocking off the table. That was backwards: one unacked message per consumer *is* head-of-line blocking — job B's architecture agent cannot start until job A's has acked. At ~5s per agent it was invisible; with agents now running as minute-scale tool loops, two concurrent jobs meant the second user waited minutes before their first agent moved, with no progress event to explain the silence.

3 is cheap because the loop is I/O-bound on the LLM — it spends its life awaiting HTTP, so three overlap on the event loop at almost no cost. It's deliberately not higher: each in-flight agent holds an open graph handle and a growing conversation, and unacked messages are redelivered on a crash, so a large prefetch means a large re-run.

**Heartbeats are now load-bearing.** amqplib sends them on the same event loop as everything else, and every CodeGraph read is synchronous (`node:sqlite`) — only `getCode` and file reads actually await. A long enough run of uninterrupted sync graph calls misses two beats, the broker drops the connection, and the in-flight message is redelivered: the agent re-runs from scratch, three times, then dead-letters. You pay 3× the tokens and still get a failed agent. So the heartbeat is pinned at 30s on every connection (including the two DLQ consumers that bypass the Nest factory), and the tool loop yields via `setImmediate` between tool executions so the beats land.

---

## State: Redis carries coordination, Postgres carries truth

Redis is not a cache here so much as the coordination substrate: completion counting, fencing, claim locks, and the pub/sub spine between synthesizer and gateway.

| Key | Type | Job |
|---|---|---|
| `job:{id}:status` | string | pending / running / done / failed |
| `job:{id}:graph_path` | string | SQLite graph location for the workers |
| `job:{id}:agents_done` | set | Completion counting via `SADD` + `SCARD` |
| `job:{id}:agents_expected` | set | What the orchestrator actually dispatched |
| `job:{id}:epoch` | string | **Fencing token.** `INCR` on force-retry; stale workers check it and abort |
| `job:{id}:synthesizing` | string | `SET NX EX 300` — one synthesis per job, no double Sonnet spend |
| `job:{id}:tokens_used` | string | `INCRBY` per agent — the live cost cap |
| `agent_context:{runKey}:{type}:{hash}` | string | Cached `buildContext` result, 24h TTL |
| `job:{runKey}:repo_facts` | string | **Zero-LLM AST ground truth** — real routes, real module edges, measured complexity, framework detection, counts. Written once after indexing; read by every agent |
| `ratelimit:job_submit:{userId}` | string | `INCR` + `EXPIRE`, 10/hour default |
| `job:{id}:ready_for_synthesis` | pub/sub | Last agent wakes the synthesizer |
| `job:{id}:events` | pub/sub | Gateway `psubscribe`s `job:*:events` and relays to Socket.io |

> **Why two of these key on `runKey` (`{jobId}-{epoch}`) rather than jobId.** Anything scoped to the *contents of a checkout* has to name the run. A force-stop increments the epoch and the orchestrator extracts a different checkout to `/tmp/repos/{runKey}`; a bare jobId plus a 24h TTL meant run 1 read back run 0's abandoned graph and context, silently, and produced a report for code the user had already replaced. Keys about the *job* — status, completion, budget, the epoch itself — legitimately span runs and stay keyed by jobId.

> **Why no Redlock.** The spec bans distributed lock libraries, and nothing here needs one. Completion is a set cardinality, synthesis exclusivity is a single `SET NX` against a single Redis, and staleness is handled by a monotonic epoch rather than a lease. Redlock would add a dependency and a failure mode to solve a problem this topology doesn't have.

**Postgres, via Prisma**

| Table | Carries |
|---|---|
| `users` | GitHub id, AES-256-GCM encrypted access token, avatar. Never plaintext. |
| `jobs` | Repo full name, status, timestamps. Indexed on `userId`. |
| `agent_results` | Raw JSON output, **`tokensUsed`**, status, duration, error. |
| `reports` | Markdown, `diagrams` jsonb, synthesis, `totalTokens`. |
| `report_shares` | 32-byte base64url token, revoke timestamp, cascade on report delete. |

---

## Diagrams: the model never writes diagram syntax

Six diagrams, each built by a pure TypeScript function, then rendered to SVG server-side.

**The honest version of this claim.** It used to read: "a diagram can only express relationships that exist in the agent's structured output, and that output came from the AST graph." The second half wasn't true. The builder was always plain TypeScript — but a deterministic builder fed invented input draws an invented graph, and `module_dependencies[]` was an LLM guess. The agent was *shown* graph context and asked to describe the wiring; nothing forced its answer to match.

Now the module graph is built from `getFileDependencies` aggregated to module level, with edge weights that count the real imports behind them. An edge on that diagram is an import that exists. The claim is true because the facts moved out of the model — not because the builder was ever the thing protecting us.

| Slug | Built from | Engine |
|---|---|---|
| `architecture-modules` | **RepoFacts `moduleDependencies[]`** — real imports, aggregated and weighted | D2 (elk) |
| `request-flow-{1..3}` | architecture `request_flows[].steps[]` | D2 |
| `security-auth-flow` | security `auth_flow_steps[]` + vulns | D2 |
| `dependency-graph` | dependency runtime deps by risk | D2 |
| `quality-donut` | quality `issues[].category` | Hand-built SVG |
| `health-gauge` | synthesis `overallHealthScore` | Hand-built SVG |

**Why the last two aren't D2.** D2 is a diagram language, not a charting library — no pie, donut, or gauge primitive. Faking one out of box shapes would be worse than writing the SVG honestly, so the two purely quantitative visuals are emitted directly. Same guarantees either way: rendered once, server-side, inert markup.

> **The bug that forced a mutex.** `@terrastruct/d2` tracks exactly one in-flight request per instance in a single `currentResolve` field, and ships no queue of its own. Two concurrent `compile()` calls means the first hangs forever and the second resolves with the first's SVG. Every render therefore goes through a mutex.
>
> On timeout the WASM instance is **destroyed, not reused** — a late worker reply would otherwise resolve the *next* diagram's promise with this one's output. A render that fails degrades to a visible placeholder and never fails the job, because the agent tokens are already spent.

**Two library lies worth documenting.** The package is **ESM-only** despite advertising a CommonJS build — that build sets `module.exports` inside a `"type": "module"` package and throws on `require()`. It's loaded with a dynamic `import()`, and `tsconfig` stays on `module: nodenext` so the emit preserves it instead of downlevelling to `require`.

Its `.d.ts` also misdescribes `compile()`'s second argument: the types say `{ options }`, the runtime reads options off the top level. The nested form compiles clean, silently ignores `layout`, and lays everything out with dagre.

---

## API: public surface

Sixteen HTTP routes, one WebSocket subscription, and six message consumers — enumerated from the code graph rather than transcribed by hand.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Unauthenticated. Pings Postgres + Redis, 503 when degraded. |
| GET | `/auth/github` | Parks `?next=` in a short-lived cookie; open-redirect guarded. |
| GET | `/auth/github/callback` | Upserts user, issues 15m access + 30d refresh cookies. |
| POST | `/auth/refresh` | Rotates the access cookie. |
| GET | `/auth/me` | Session probe. 401 is a normal answer, not an error. |
| POST | `/auth/logout` | Clears cookies. |
| GET | `/repos` | One GitHub GraphQL query, repos + language breakdown, joined to latest job. |
| POST | `/analyze/:repoId` | Rate-limited. Returns `jobId` immediately. |
| GET | `/jobs/:id` | Job + agent results + report payload. |
| POST | `/jobs/:id/retry` | Re-dispatches failed agents only. |
| POST | `/jobs/:id/stop-retry` | Bumps the epoch, fencing off in-flight workers. |
| GET | `/jobs/:id/share` | Returns `null` + empty body when no link exists. |
| POST | `/jobs/:id/share` | Idempotent create. |
| DELETE | `/jobs/:id/share` | Revoke by timestamp. |
| GET | `/share/:token` | Public. 404 — never 403 — on unknown or revoked, so tokens can't be probed. |
| GET | `/jobs/:id/export` | `?format=md\|pdf`. PDF failure falls back to Markdown rather than erroring. |
| WS | `subscribe` | Joins a room keyed by jobId. |
| EVT | `analysis.requested` | Orchestrator consumer. |
| EVT | `agent.*` ×5 | Worker consumers, one channel each. |

---

## Failure design: what happens when things go wrong

| Scenario | Behaviour |
|---|---|
| A model returns malformed JSON | Fences are stripped and the reply is parsed, then validated against the agent's schema. Either failure marks that agent failed and records why; the synthesizer proceeds with whoever succeeded. |
| Every agent fails | The synthesizer refuses to spend a Sonnet call on nothing and fails the job explicitly, rather than producing an empty report. |
| A worker dies mid-run | The message dead-letters after 3 delivery attempts. `recordInfraFailure` writes a failed result *and* advances completion tracking, so the job can't hang forever waiting for a set member that will never arrive. |
| A user force-retries while agents are in flight | The epoch increments. Stale workers compare it before writing and abort, so a zombie run can't clobber the new one's results. |
| A diagram fails to render | Placeholder with `degraded: true`. The renderer never throws — the section data below it is intact and already paid for. |
| Chromium missing / PDF generation fails | Export falls back to serving Markdown instead of returning a 500. |

---

## Honest state: what's done, what isn't

Phases 1, 2 and 4 are complete; Phase 3's backend half is complete. The gaps below are real and unannotated — there is not a single `TODO` or `FIXME` anywhere in `apps/` or `libs/`, which means they won't announce themselves.

| Status | Item | Detail |
|---|---|---|
| **Thin** | Test coverage is 5 spec files | Only the SVG utils and the two diagram builders are tested. Zero tests for any controller, service, consumer, agent, or the LLM client. `test/` holds a Jest e2e config and no e2e specs. |
| **Broken** | `prisma/` has no `migrations/` directory | Yet the compose `migrate` service runs `prisma migrate deploy`, which needs committed migrations. A clean-clone deploy has nothing to apply. |
| **Broken** | No `.env.example` | The README instructs `cp .env.example .env` twice. Only a real `.env` exists, and it's sitting in the working tree. |
| **Stale** | `codebase_audit_and_feature_list.md` predates two migrations | Claims PDF export throws `NotImplementedException` (implemented), describes Mermaid (it's D2), says TypeORM (it's Prisma), lists a Postgres compose service (dropped for Supabase). The README, by contrast, is accurate. |
| **Fixed** | Agent output is schema-validated at the boundary | It wasn't. `safeParseJson` returned `{ raw }` on a parse failure and the caller marked it `success: true`, so the synthesizer's "did *every* agent fail?" guard could never fire and `{raw: "..."}` was handed to the synthesis call as though it were an analysis. Output now validates against a spec in `libs/common/src/schema/`, which is also the source of the `emit_*` tool's JSON Schema — one definition, so the shape the model is told and the shape the reader enforces cannot drift. The reader's types stay all-optional on purpose: an agent can still fail, and consumers must still guard. |
| **Stale** | The README says the frontend isn't built | It lists Phase 3's frontend as unchecked and states "the frontend consuming this API is still in progress". It exists — CodeMind-web, ~9,100 lines, all four routes, consuming 15 of these endpoints. It lives in a separate repository rather than this monorepo, which is why the checklist never caught up. |
| **Contract bug** | The client calls an auth route that doesn't exist | CodeMind-web's login page links a Google button to `/auth/google`. There is no Google strategy here — the only strategies are GitHub and JWT. Fix belongs on one side or the other, but the button currently 404s. |
| **Missing** | Demo video not recorded | The last unchecked Phase 4 item. |

---

## Defence: claims that survive follow-up questions

Each of these is checkable against the code, which is the only reason to say them out loud.

- "I didn't send full files to the model. I pre-built a code knowledge graph via tree-sitter AST parsing — zero LLM cost — then agents queried it with targeted semantic questions and got back only relevant nodes."
- "The fan-out isn't a loop, and each agent is. Those are different axes, and conflating them is the mistake. The five analyses are independent — nothing security finds changes what docs should look at — so they fan out over a topic exchange rather than chaining. But *within* one agent, the work is exactly sequential-with-feedback: you can't know which symbol to read next until you've read the last one. So each agent is a bounded evidence loop over the code graph, and the dispatch between them still isn't."
- "One keyword query and one shot is why the old reports read like a form. An agent got 20 nodes chosen before it had seen anything, and no way to ask a follow-up. The gap between 'auth looks fine' and 'AuthGuard is bypassed by the three routes that never declare it' isn't the model or the prompt — it's about forty tool calls."
- "One agent-worker process with five queue consumers, not five microservices. Decoupled by routing key, but they share runtime dependencies and don't need independent scaling at this size."
- "Token usage is written per agent run to Postgres specifically so cost is measurable and cappable — not 'trust me, it's cheap.'"
- "Diagrams are built from structured agent JSON in plain TypeScript, so they can't express a relationship that isn't in the code."
- "I render D2 to SVG server-side at report-build time. Mermaid only renders in a browser, so the PDF exporter had to inject a CDN script and hope Puppeteer ran it before capture — a race that failed silently into raw code blocks. The SVG is inert now: both the PDF path and the browser just embed a string."
- "The stored Markdown keeps the diagram source, not the SVG, so a .md export stays a readable, diffable document and restyling every diagram never means re-running the agents."

---

*CodeMind · backend · `apps/{api-gateway, orchestrator, agent-worker, synthesizer}` · counts from CodeGraph · main @ 1f95052*
