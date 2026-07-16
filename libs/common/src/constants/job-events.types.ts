export type JobEventPayload =
  | { type: 'job:status'; jobId: string; status: string }
  | {
      type: 'job:progress';
      jobId: string;
      agentType: string;
      done: number;
      total: number;
    }
  /**
   * Heartbeat from inside one agent's evidence loop, once per turn.
   *
   * `job:progress` only fires when an agent *finishes*. That was fine when a run
   * took ~5s; now an agent is a tool loop that can work for minutes, so the UI
   * correctly showed five agents "running" and then sat unchanged long enough to
   * read as hung. This is the missing signal.
   *
   * **Not agent thoughts** (CLAUDE.md Section 2 bans streaming those). `activity`
   * is a mechanical description of the tool calls the loop just made — "reading
   * auth.guard.ts", "searching 'jwt guard'". No model prose, no thinking blocks,
   * no output text ever crosses this channel.
   */
  | {
      type: 'job:agent_activity';
      jobId: string;
      agentType: string;
      /** 1-indexed. */
      turn: number;
      maxTurns: number;
      /** Short human-readable phrase, already truncated for display. */
      activity: string;
    }
  | { type: 'job:complete'; jobId: string }
  | { type: 'job:failed'; jobId: string; reason: string };
