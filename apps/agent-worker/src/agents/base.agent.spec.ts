import type Anthropic from '@anthropic-ai/sdk';
import type { LlmConverseParams } from '@app/common';
import { EpochFencedError, noTokens } from '@app/common';
import { BaseAgent, AgentContext } from './base.agent';
import type { ToolContext } from '@app/common';

// A minimal agent whose emit schema is the docs one (small, easy to satisfy).
class TestAgent extends BaseAgent {
  readonly agentType = 'docs' as const;
  readonly rolePrompt = 'test brief';
  maxTurns = 4;
  buildUserMessage(): string {
    return 'analyse this';
  }
}

const VALID_DOCS_OUTPUT = {
  readme_quality: 'good',
  api_documented: true,
  has_contribution_guide: false,
  has_changelog: false,
  inline_comment_density: 'medium',
  doc_score: 72,
  summary: 'Reasonable README, no contribution guide.',
};

const usage = () => ({
  input: 100,
  output: 50,
  cacheCreation: 0,
  cacheRead: 0,
});

const toolUse = (name: string, input: unknown, id = 'tu_1') =>
  ({ type: 'tool_use', id, name, input }) as Anthropic.ToolUseBlock;

const turn = (content: Anthropic.ContentBlock[]) => ({
  stopReason: 'tool_use' as const,
  content,
  usage: usage(),
});

/** A tool context whose graph answers everything; individual tests override. */
const toolCtx = (over: Partial<{ search: unknown; code: unknown }> = {}) =>
  ({
    repoPath: '/tmp/repos/j-0',
    cg: {
      searchNodes: () =>
        over.search ?? [
          {
            node: {
              id: 'n1',
              kind: 'function',
              name: 'handler',
              filePath: 'src/a.ts',
              startLine: 10,
            },
          },
        ],
      getNode: () => ({
        id: 'n1',
        kind: 'function',
        name: 'handler',
        filePath: 'src/a.ts',
        startLine: 10,
      }),
      getCode: () => Promise.resolve(over.code ?? 'function handler() {}'),
    },
  }) as unknown as ToolContext;

const baseCtx = (over: Partial<AgentContext> = {}): AgentContext => ({
  jobId: 'j',
  repoPath: '/tmp/repos/j-0',
  graphContext: 'seed context',
  tools: toolCtx(),
  ...over,
});

type ConverseMock = jest.Mock;

/**
 * The params the loop passed to converse() on turn `i` (0-indexed).
 *
 * jest.fn() is Mock<any, any>, so every call-arg access is untyped. One cast
 * here beats scattering them (or eslint-disables) across every assertion.
 */
const argsOf = (m: ConverseMock, i: number): LlmConverseParams =>
  (m.mock.calls as unknown as LlmConverseParams[][])[i][0];

function withClient(agent: BaseAgent, converse: ConverseMock) {
  (agent as unknown as { client: unknown }).client = { converse };
  return agent;
}

describe('BaseAgent evidence loop', () => {
  it('gathers evidence across turns, then emits', () => {
    const converse = jest
      .fn()
      .mockResolvedValueOnce(
        turn([toolUse('search_nodes', { query: 'readme' })]),
      )
      .mockResolvedValueOnce(turn([toolUse('get_code', { node_id: 'n1' })]))
      .mockResolvedValueOnce(turn([toolUse('emit_docs', VALID_DOCS_OUTPUT)]));

    const agent = withClient(new TestAgent(), converse);

    return agent.run(baseCtx()).then((res) => {
      expect(res.success).toBe(true);
      expect(res.output.doc_score).toBe(72);
      expect(converse).toHaveBeenCalledTimes(3);
      // Usage accumulates across every turn, not just the last one.
      expect(res.tokensUsed.input).toBe(300);
      expect(res.tokensUsed.output).toBe(150);
    });
  });

  it('returns a failing tool as is_error and keeps going', async () => {
    // The single most important semantic in the loop. The model asked for a node
    // that doesn't exist; telling it so lets it recover. Throwing would discard
    // every turn already paid for.
    const converse = jest
      .fn()
      .mockResolvedValueOnce(turn([toolUse('get_code', { node_id: 'nope' })]))
      .mockResolvedValueOnce(turn([toolUse('emit_docs', VALID_DOCS_OUTPUT)]));

    const ctx = baseCtx({
      tools: {
        repoPath: '/tmp/repos/j-0',
        cg: {
          getNode: () => null,
        },
      } as unknown as ToolContext,
    });

    const res = await withClient(new TestAgent(), converse).run(ctx);

    expect(res.success).toBe(true);
    const secondCallMessages = argsOf(converse, 1).messages;
    const results = secondCallMessages.at(-1)!
      .content as Anthropic.ToolResultBlockParam[];
    expect(results[0].is_error).toBe(true);
    expect(JSON.stringify(results[0].content)).toContain('No node with id');
  });

  it('returns every parallel tool result in ONE user message', async () => {
    // Splitting them across messages silently trains the model out of parallel
    // tool calls — a quiet, permanent slowdown that looks like nothing.
    const converse = jest
      .fn()
      .mockResolvedValueOnce(
        turn([
          toolUse('search_nodes', { query: 'a' }, 'tu_a'),
          toolUse('search_nodes', { query: 'b' }, 'tu_b'),
          toolUse('search_nodes', { query: 'c' }, 'tu_c'),
        ]),
      )
      .mockResolvedValueOnce(turn([toolUse('emit_docs', VALID_DOCS_OUTPUT)]));

    await withClient(new TestAgent(), converse).run(baseCtx());

    const messages = argsOf(converse, 1).messages;
    const userTurns = messages.filter((m) => m.role === 'user');
    // Seed + exactly one tool-result message — not three.
    expect(userTurns).toHaveLength(2);
    expect(userTurns[1].content).toHaveLength(3);
  });

  it('forces the emit tool on the final turn', async () => {
    const converse = jest
      .fn()
      .mockResolvedValue(turn([toolUse('search_nodes', { query: 'x' })]));
    const agent = new TestAgent();
    agent.maxTurns = 2;

    await withClient(agent, converse).run(baseCtx());

    expect(argsOf(converse, 0).toolChoice).toBeUndefined();
    expect(argsOf(converse, 1).toolChoice).toEqual({
      type: 'tool',
      name: 'emit_docs',
      disable_parallel_tool_use: true,
    });
  });

  it('forces emit when the budget runs out, and marks the result truncated', async () => {
    // Running out of budget must still produce a real analysis. The alternative
    // — a hard fail — throws away everything already paid for.
    const converse = jest
      .fn()
      .mockResolvedValueOnce({
        stopReason: 'tool_use' as const,
        content: [toolUse('search_nodes', { query: 'x' })],
        usage: { input: 20_000, output: 100, cacheCreation: 0, cacheRead: 0 },
      })
      .mockResolvedValueOnce(turn([toolUse('emit_docs', VALID_DOCS_OUTPUT)]));

    const res = await withClient(new TestAgent(), converse).run(
      baseCtx({ agentTokenBudget: 25_000 }),
    );

    expect(res.success).toBe(true);
    expect(res.output.truncated).toBe(true);
    expect(argsOf(converse, 1).toolChoice).toMatchObject({
      name: 'emit_docs',
    });
  });

  it('aborts the loop when the run is fenced mid-flight', async () => {
    // A fence trip must propagate, not become a failed AgentResult — the caller
    // has to ack without recording anything or advancing completion.
    const converse = jest
      .fn()
      .mockResolvedValue(turn([toolUse('search_nodes', { query: 'x' })]));

    let calls = 0;
    const ctx = baseCtx({
      checkAlive: () => {
        if (++calls > 1) throw new EpochFencedError('j', 0, 1);
        return Promise.resolve();
      },
    });

    await expect(
      withClient(new TestAgent(), converse).run(ctx),
    ).rejects.toThrow(EpochFencedError);
    // Stopped at the fence rather than burning the remaining turns.
    expect(converse).toHaveBeenCalledTimes(1);
  });

  it('fails when the emitted payload does not satisfy the schema', async () => {
    // Invalid twice: the first rejection buys one repair turn, the second has
    // no repair left and the agent fails for real.
    const converse = jest
      .fn()
      .mockResolvedValueOnce(
        turn([toolUse('emit_docs', { doc_score: 'high' })]),
      )
      .mockResolvedValueOnce(
        turn([toolUse('emit_docs', { doc_score: 'high' })]),
      );

    const res = await withClient(new TestAgent(), converse).run(baseCtx());

    expect(res.success).toBe(false);
    expect(res.error).toContain('schema validation');
    // Tokens are still billed — the spend happened whether or not it was usable.
    expect(res.tokensUsed.input).toBe(200);
  });

  it('gives a schema-invalid emit one turn to repair itself', async () => {
    // `strict: true` should make this unreachable, but it has been observed
    // emitting only optional fields on a forced last turn. Throwing away a loop
    // that already spent its whole budget over a fixable shape is the expensive
    // failure; one more turn is the cheap one.
    const converse = jest
      .fn()
      .mockResolvedValueOnce(
        turn([toolUse('emit_docs', { doc_score: 'high' })]),
      )
      .mockResolvedValueOnce(turn([toolUse('emit_docs', VALID_DOCS_OUTPUT)]));

    const res = await withClient(new TestAgent(), converse).run(baseCtx());

    expect(res.success).toBe(true);
    expect(res.output).toMatchObject({ doc_score: 72 });
    expect(converse).toHaveBeenCalledTimes(2);

    // The correction must come back as an errored tool_result: it is the only
    // block allowed to follow a tool_use, and `is_error` is what tells the model
    // to try again rather than treat the rejection as data.
    const repairMessages = (converse.mock.calls[1][0] as LlmConverseParams)
      .messages;
    const last = repairMessages[repairMessages.length - 1];
    const block = (last.content as Anthropic.ToolResultBlockParam[])[0];
    expect(last.role).toBe('user');
    expect(block.type).toBe('tool_result');
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('required field missing');
  });

  it('nudges when the model answers in prose instead of calling emit', async () => {
    const converse = jest
      .fn()
      .mockResolvedValueOnce({
        stopReason: 'end_turn' as const,
        content: [{ type: 'text', text: 'The docs seem fine.' }],
        usage: usage(),
      })
      .mockResolvedValueOnce(turn([toolUse('emit_docs', VALID_DOCS_OUTPUT)]));

    const res = await withClient(new TestAgent(), converse).run(baseCtx());

    expect(res.success).toBe(true);
    const messages = argsOf(converse, 1).messages;
    // The nudge is a string when pushed; withRollingCache promotes it to a text
    // block so it can carry the cache breakpoint.
    expect(JSON.stringify(messages.at(-1)!.content)).toContain('emit_docs');
  });

  it('puts exactly one cache breakpoint, on the newest turn', async () => {
    // A breakpoint on the system prompt would silently never cache (under
    // Sonnet 4.6's 2048-token minimum), and leaving old ones in place would blow
    // the 4-breakpoint cap.
    const converse = jest
      .fn()
      .mockResolvedValueOnce(turn([toolUse('search_nodes', { query: 'x' })]))
      .mockResolvedValueOnce(turn([toolUse('emit_docs', VALID_DOCS_OUTPUT)]));

    await withClient(new TestAgent(), converse).run(baseCtx());

    const messages = argsOf(converse, 1).messages;
    const marked = messages.flatMap((m) =>
      typeof m.content === 'string'
        ? []
        : m.content.filter(
            (b) => (b as { cache_control?: unknown }).cache_control,
          ),
    );
    expect(marked).toHaveLength(1);
    expect(messages.at(-1)!.content).toContain(marked[0]);
  });

  it('emits a turn-level activity line so the UI is not silent for minutes', async () => {
    // job:progress only fires when an agent FINISHES. At 5s per agent that was
    // fine; with a minute-scale loop it left five agents shown as "running" and
    // nothing moving, which reads as hung. This is the missing heartbeat.
    const converse = jest
      .fn()
      .mockResolvedValueOnce(
        turn([toolUse('search_nodes', { query: 'jwt guard' })]),
      )
      .mockResolvedValueOnce(turn([toolUse('emit_docs', VALID_DOCS_OUTPUT)]));

    const seen: { turn: number; maxTurns: number; activity: string }[] = [];
    await withClient(new TestAgent(), converse).run(
      baseCtx({ onActivity: (a) => seen.push(a) }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ turn: 1, maxTurns: 4 });
    expect(seen[0].activity).toBe('searching for “jwt guard”');
  });

  it('summarises a parallel turn instead of emitting a wall of text', async () => {
    const converse = jest
      .fn()
      .mockResolvedValueOnce(
        turn([
          toolUse('search_nodes', { query: 'a' }, 't1'),
          toolUse('search_nodes', { query: 'b' }, 't2'),
          toolUse('search_nodes', { query: 'c' }, 't3'),
          toolUse('search_nodes', { query: 'd' }, 't4'),
        ]),
      )
      .mockResolvedValueOnce(turn([toolUse('emit_docs', VALID_DOCS_OUTPUT)]));

    const seen: { activity: string }[] = [];
    await withClient(new TestAgent(), converse).run(
      baseCtx({ onActivity: (a) => seen.push(a) }),
    );

    expect(seen[0].activity).toBe(
      'searching for “a”, searching for “b” +2 more',
    );
  });

  it('never fails an agent because a progress listener threw', async () => {
    // A progress line is cosmetic. The agent's work is not.
    const converse = jest
      .fn()
      .mockResolvedValueOnce(turn([toolUse('search_nodes', { query: 'x' })]))
      .mockResolvedValueOnce(turn([toolUse('emit_docs', VALID_DOCS_OUTPUT)]));

    const res = await withClient(new TestAgent(), converse).run(
      baseCtx({
        onActivity: () => {
          throw new Error('socket exploded');
        },
      }),
    );

    expect(res.success).toBe(true);
  });

  it('refuses to run without a tool context rather than silently one-shotting', async () => {
    const converse = jest.fn();
    const res = await withClient(new TestAgent(), converse).run(
      baseCtx({ tools: undefined }),
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain('tool context');
    expect(converse).not.toHaveBeenCalled();
    expect(res.tokensUsed).toEqual(noTokens());
  });
});
