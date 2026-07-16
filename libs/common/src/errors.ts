/**
 * Thrown when a run has been superseded mid-flight.
 *
 * A force-stop increments `job:{id}:epoch`. Before agents were loops, that only
 * needed checking once at message receipt — the work took ~5 seconds and the
 * window was nil. A loop runs for minutes, so the fence has to be re-checked
 * every turn, and the abort has to unwind cleanly from deep inside it.
 *
 * This is the one failure that must **not** record an agent result and must not
 * `SADD` into `agents_done`. Every other failure path advances completion so the
 * job can't hang; this one deliberately doesn't, because tripping completion for
 * an abandoned run would fire synthesis for a job the user already replaced.
 * Same semantics as the pre-flight fence: ack the message, write nothing.
 */
export class EpochFencedError extends Error {
  constructor(
    readonly jobId: string,
    readonly messageEpoch: number,
    readonly currentEpoch: number,
  ) {
    super(
      `Run superseded: message epoch ${messageEpoch} != current ${currentEpoch} [job=${jobId}]`,
    );
    this.name = 'EpochFencedError';
  }
}
