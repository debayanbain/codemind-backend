import * as fs from 'fs/promises';
import * as path from 'path';
import type Anthropic from '@anthropic-ai/sdk';
import type CodeGraph from '@colbymchenry/codegraph';

/**
 * The agent's read-only view of the codebase.
 *
 * This is the whole point of the rebuild. An agent used to get one keyword-bag
 * `buildContext` call — 20 nodes, chosen before it had seen anything — and one
 * shot at an answer. It could not ask a follow-up about code it had just read.
 * That single constraint, not the model and not the prompt, is why the reports
 * were shallow: the difference between a report that says "auth looks fine" and
 * one that says "AuthGuard at auth.guard.ts:34 is bypassed by the 3 routes that
 * never declare it" is roughly forty tool calls.
 *
 * Design rules, all learned the hard way:
 *
 *  - **Everything returns `file:line`.** A claim an agent can't point at is a
 *    claim we can't ship. Citations are what make the report checkable.
 *  - **Read-only.** No tool mutates anything. The blast radius of a confused
 *    agent is wasted tokens.
 *  - **No full-graph traversals here.** `findCircularDependencies` and
 *    `findDeadCode` are whole-graph walks; they run once in the orchestrator's
 *    pre-pass and arrive as facts. Exposing them as tools would mean five
 *    agents each stalling the event loop on the same synchronous work.
 *  - **Bounded output.** Every tool caps its result. An agent that pulls a
 *    3,000-line file into context has spent its budget on one file.
 */

export interface ToolContext {
  cg: CodeGraph;
  /** Absolute path to this run's checkout. Nothing may be read outside it. */
  repoPath: string;
}

export interface AgentTool {
  def: Anthropic.Tool;
  /**
   * Sync or async, and the distinction is real rather than cosmetic: every
   * CodeGraph read is synchronous (`node:sqlite`), and only `getCode` and file
   * reads actually hit the disk. Dressing the sync ones up as `async` would
   * hide the fact that they block the event loop — which is exactly the thing
   * the caller has to yield around to keep AMQP heartbeats alive.
   */
  run(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): string | Promise<string>;
  /**
   * A short phrase for the progress UI: "reading auth.guard.ts".
   *
   * Lives on the tool rather than in a switch elsewhere so a new tool can't
   * silently render as "working…". Must never throw and never include model
   * output — this is the one thing here that reaches a user's screen live.
   */
  describe(input: Record<string, unknown>, ctx: ToolContext): string;
}

const MAX_SEARCH_RESULTS = 15;
const MAX_RELATED = 20;
const MAX_CODE_CHARS = 6000;
const MAX_FILE_CHARS = 8000;
const MAX_LIST_FILES = 100;

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim())
    throw new Error(`"${name}" must be a non-empty string`);
  return v;
};

const loc = (n: { filePath: string; startLine: number }) =>
  `${n.filePath}:${n.startLine}`;

// ── Tools ───────────────────────────────────────────────────────────────────

const searchNodes: AgentTool = {
  def: {
    name: 'search_nodes',
    description:
      'Search the code graph for symbols (functions, classes, methods, interfaces) by name or keyword. ' +
      'Use this first to find the symbols relevant to your analysis, then use get_code to read them. ' +
      'Returns node IDs you can pass to get_code, get_callers, get_callees and get_node_metrics.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords to search for, e.g. "authenticate jwt guard".',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  run(input, ctx) {
    const results = ctx.cg
      .searchNodes(str(input.query, 'query'))
      .slice(0, MAX_SEARCH_RESULTS);
    if (!results.length) return 'No symbols matched that query.';

    return results
      .map((r) => {
        const n = r.node;
        return `- ${n.kind} ${n.name} (${loc(n)}) [id: ${n.id}]`;
      })
      .join('\n');
  },
  describe(input) {
    return `searching for ${quoted(input.query)}`;
  },
};

const getCode: AgentTool = {
  def: {
    name: 'get_code',
    description:
      "Read a symbol's actual source code by node ID (from search_nodes). " +
      'Use this to verify a claim before you make it.',
    input_schema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'Node ID from search_nodes.' },
      },
      required: ['node_id'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const id = str(input.node_id, 'node_id');
    const node = ctx.cg.getNode(id);
    if (!node)
      throw new Error(`No node with id "${id}". Use search_nodes first.`);

    const code = await ctx.cg.getCode(id);
    if (!code) return `${loc(node)} — source unavailable.`;

    return [
      `// ${loc(node)} (${node.kind} ${node.name})`,
      truncate(code, MAX_CODE_CHARS),
    ].join('\n');
  },
  describe(input, ctx) {
    return `reading ${symbolName(input.node_id, ctx)}`;
  },
};

const getCallers: AgentTool = {
  def: {
    name: 'get_callers',
    description:
      'Find what calls a symbol. Use this to judge blast radius, or to check whether ' +
      'a guard/validator is actually reached by the code paths you think it is.',
    input_schema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'Node ID from search_nodes.' },
      },
      required: ['node_id'],
      additionalProperties: false,
    },
  },
  run(input, ctx) {
    const callers = ctx.cg
      .getCallers(str(input.node_id, 'node_id'))
      .slice(0, MAX_RELATED);
    if (!callers.length) return 'Nothing calls this symbol.';
    return callers.map((c) => `- ${c.node.name} (${loc(c.node)})`).join('\n');
  },
  describe(input, ctx) {
    return `tracing callers of ${symbolName(input.node_id, ctx)}`;
  },
};

const getCallees: AgentTool = {
  def: {
    name: 'get_callees',
    description: 'Find what a symbol calls. Use this to trace a flow forwards.',
    input_schema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'Node ID from search_nodes.' },
      },
      required: ['node_id'],
      additionalProperties: false,
    },
  },
  run(input, ctx) {
    const callees = ctx.cg
      .getCallees(str(input.node_id, 'node_id'))
      .slice(0, MAX_RELATED);
    if (!callees.length)
      return 'This symbol calls nothing tracked by the graph.';
    return callees.map((c) => `- ${c.node.name} (${loc(c.node)})`).join('\n');
  },
  describe(input, ctx) {
    return `tracing what ${symbolName(input.node_id, ctx)} calls`;
  },
};

const getNodeMetrics: AgentTool = {
  def: {
    name: 'get_node_metrics',
    description:
      'Get measured coupling for a symbol: caller count, call count, nesting depth. ' +
      'Use this instead of eyeballing whether something looks complex.',
    input_schema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'Node ID from search_nodes.' },
      },
      required: ['node_id'],
      additionalProperties: false,
    },
  },
  run(input, ctx) {
    const id = str(input.node_id, 'node_id');
    const m = ctx.cg.getNodeMetrics(id);
    return (
      `callers=${m.callerCount} calls=${m.callCount} depth=${m.depth} ` +
      `children=${m.childCount} in=${m.incomingEdgeCount} out=${m.outgoingEdgeCount}`
    );
  },
  describe(input, ctx) {
    return `measuring ${symbolName(input.node_id, ctx)}`;
  },
};

const getFileDependencies: AgentTool = {
  def: {
    name: 'get_file_dependencies',
    description:
      'List the files a given file imports. Use this to trace wiring between modules.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Repo-relative path, e.g. "src/auth/auth.service.ts".',
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  run(input, ctx) {
    const deps = ctx.cg
      .getFileDependencies(str(input.file_path, 'file_path'))
      .slice(0, MAX_RELATED);
    if (!deps.length) return 'This file imports nothing tracked by the graph.';
    return deps.map((d) => `- ${d}`).join('\n');
  },
  describe(input) {
    return `mapping imports of ${basename(input.file_path)}`;
  },
};

const listFiles: AgentTool = {
  def: {
    name: 'list_files',
    description:
      'List indexed files, optionally filtered by a path prefix. Use this to orient ' +
      'inside a module before reading it.',
    input_schema: {
      type: 'object',
      properties: {
        path_prefix: {
          type: 'string',
          description: 'Optional repo-relative prefix, e.g. "src/auth".',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  run(input, ctx) {
    const prefix =
      typeof input.path_prefix === 'string' ? input.path_prefix : '';
    const files = ctx.cg
      .getFiles()
      .map((f) => f.path)
      .filter((p) => p.startsWith(prefix))
      .slice(0, MAX_LIST_FILES);
    if (!files.length) return `No indexed files under "${prefix}".`;
    return files.map((f) => `- ${f}`).join('\n');
  },
  describe(input) {
    const p = typeof input.path_prefix === 'string' && input.path_prefix;
    return p ? `listing ${p}` : 'listing files';
  },
};

const readFile: AgentTool = {
  def: {
    name: 'read_file',
    description:
      'Read a file from the repository by repo-relative path. Use this for files the ' +
      'graph does not index as symbols — config, Dockerfile, CI workflows, docs.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Repo-relative path, e.g. "Dockerfile" or "README.md".',
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const rel = str(input.file_path, 'file_path');
    const abs = resolveInside(ctx.repoPath, rel);
    const content = await fs.readFile(abs, 'utf-8');
    return truncate(content, MAX_FILE_CHARS);
  },
  describe(input) {
    return `reading ${basename(input.file_path)}`;
  },
};

export const GRAPH_TOOLS: readonly AgentTool[] = [
  searchNodes,
  getCode,
  getCallers,
  getCallees,
  getNodeMetrics,
  getFileDependencies,
  listFiles,
  readFile,
];

export const GRAPH_TOOL_DEFS: readonly Anthropic.Tool[] = GRAPH_TOOLS.map(
  (t) => t.def,
);

const BY_NAME = new Map(GRAPH_TOOLS.map((t) => [t.def.name, t]));

export const findTool = (name: string): AgentTool | undefined =>
  BY_NAME.get(name);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a model-supplied path and refuse anything outside the checkout.
 *
 * `file_path` is untrusted model output. Without this, `../../../../etc/passwd`
 * — or a prompt-injected instruction inside an analysed repo telling the agent
 * to read one — walks straight out of the sandbox. The repo being analysed is
 * arbitrary third-party code, so its *contents* are hostile input by default.
 */
function resolveInside(repoPath: string, rel: string): string {
  const root = path.resolve(repoPath);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(
      `"${rel}" resolves outside the repository. Only repo-relative paths are readable.`,
    );
  }
  return abs;
}

function truncate(s: string, max: number): string {
  return s.length <= max
    ? s
    : `${s.slice(0, max)}\n... [truncated at ${max} chars]`;
}

// ── describe() helpers ──────────────────────────────────────────────────────
//
// These feed a live progress line, so they must never throw: `describe` runs on
// model-supplied input that hasn't been validated yet (validation happens in
// `run`), and a crash here would take down a turn purely to render a label.
// Every one degrades to something honest and vague instead.

/** How long an activity phrase may get before the UI has to truncate it. */
const MAX_ACTIVITY_CHARS = 60;

const clip = (s: string): string =>
  s.length <= MAX_ACTIVITY_CHARS ? s : `${s.slice(0, MAX_ACTIVITY_CHARS - 1)}…`;

const quoted = (v: unknown): string =>
  typeof v === 'string' && v.trim() ? `“${clip(v.trim())}”` : 'the code graph';

const basename = (v: unknown): string =>
  typeof v === 'string' && v.trim() ? clip(path.basename(v.trim())) : 'a file';

/**
 * Resolve a node id to its symbol name for display. The model may pass an id
 * that doesn't exist — that's a normal tool error, not a reason to fail here.
 */
function symbolName(id: unknown, ctx: ToolContext): string {
  if (typeof id !== 'string' || !id.trim()) return 'a symbol';
  try {
    const node = ctx.cg.getNode(id);
    return node
      ? clip(`${node.name} (${path.basename(node.filePath)})`)
      : 'a symbol';
  } catch {
    return 'a symbol';
  }
}

/**
 * Turn a turn's tool calls into one progress phrase.
 *
 * Caps at two named actions so a parallel turn reads as "reading X, searching Y
 * +3 more" rather than a wall of text the UI has to truncate mid-word.
 */
export function describeToolUses(
  uses: { name: string; input: unknown }[],
  ctx: ToolContext,
): string {
  const phrases = uses.map((u) => {
    const tool = BY_NAME.get(u.name);
    if (!tool) return u.name;
    try {
      return tool.describe((u.input ?? {}) as Record<string, unknown>, ctx);
    } catch {
      return u.name;
    }
  });

  if (!phrases.length) return 'thinking';
  if (phrases.length <= 2) return phrases.join(', ');
  return `${phrases.slice(0, 2).join(', ')} +${phrases.length - 2} more`;
}
