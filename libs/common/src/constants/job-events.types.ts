export type JobEventPayload =
  | { type: 'job:status'; jobId: string; status: string }
  | {
      type: 'job:progress';
      jobId: string;
      agentType: string;
      done: number;
      total: number;
    }
  | { type: 'job:complete'; jobId: string }
  | { type: 'job:failed'; jobId: string; reason: string };
