import { CodeGraphService } from './codegraph.service';
import CodeGraph from '@colbymchenry/codegraph';

jest.mock('@colbymchenry/codegraph', () => ({
  __esModule: true,
  default: { open: jest.fn(), init: jest.fn() },
}));

// CodeGraph.open is a static factory replaced by jest.fn() above — there is no
// `this` to lose, which is all unbound-method guards against.
// eslint-disable-next-line @typescript-eslint/unbound-method
const openMock = CodeGraph.open as jest.Mock;

/** A stand-in for an open graph handle, tagged so we can tell runs apart. */
const fakeHandle = (tag: string) => ({ tag, close: jest.fn() });

// The service only uses redis inside buildContext; the cache tests below don't
// reach it, so a null-ish stub is enough.
const redisStub = { get: jest.fn(), set: jest.fn() } as never;

describe('CodeGraphService handle cache', () => {
  let service: CodeGraphService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CodeGraphService(redisStub);
  });

  it("does not serve a superseded run the previous run's graph", async () => {
    // The bug: the cache was keyed by jobId, but each run is extracted to
    // /tmp/repos/{jobId}-{epoch}. A force-stop bumps the epoch, the orchestrator
    // indexes a fresh checkout, and run 1's agents asked for run 1's path — but
    // got run 0's handle back on a jobId cache hit. Every agent then analysed the
    // abandoned checkout. No error, no log: just a report for the wrong code.
    const jobId = 'job-abc';
    openMock
      .mockResolvedValueOnce(fakeHandle('run-0'))
      .mockResolvedValueOnce(fakeHandle('run-1'));

    const run0 = await service.openReadOnly(`/tmp/repos/${jobId}-0`, jobId);
    const run1 = await service.openReadOnly(`/tmp/repos/${jobId}-1`, jobId);

    expect(run0).not.toBe(run1);
    expect(openMock).toHaveBeenCalledTimes(2);
  });

  it('shares one handle across the 5 agents of the same run', async () => {
    const path = '/tmp/repos/job-abc-0';
    openMock.mockResolvedValue(fakeHandle('run-0'));

    const handles = await Promise.all([
      service.openReadOnly(path, 'job-abc'),
      service.openReadOnly(path, 'job-abc'),
      service.openReadOnly(path, 'job-abc'),
    ]);

    expect(new Set(handles).size).toBe(1);
    expect(openMock).toHaveBeenCalledTimes(1);
  });

  it('opens once when all 5 agents race in before the first open resolves', async () => {
    // Caching the resolved handle instead of the promise left a check-then-await
    // gap: five consumers all miss the cache, all call open(), four handles get
    // overwritten in the Map and leak their file descriptors for the life of the
    // process. Caching the promise closes the gap.
    const path = '/tmp/repos/job-abc-0';
    let resolveOpen!: (h: unknown) => void;
    openMock.mockReturnValue(
      new Promise((res) => {
        resolveOpen = res;
      }),
    );

    const inflight = Promise.all([
      service.openReadOnly(path, 'job-abc'),
      service.openReadOnly(path, 'job-abc'),
      service.openReadOnly(path, 'job-abc'),
      service.openReadOnly(path, 'job-abc'),
      service.openReadOnly(path, 'job-abc'),
    ]);
    resolveOpen(fakeHandle('run-0'));

    expect(new Set(await inflight).size).toBe(1);
    expect(openMock).toHaveBeenCalledTimes(1);
  });

  it('closing a superseded run leaves the live run open', async () => {
    // close() used to take a jobId, so the two runs collided on one cache slot.
    // Keyed by path, a stale run tearing itself down cannot reach into the live
    // run's handle — which matters now that agents hold it for minutes, not
    // seconds.
    const jobId = 'job-abc';
    const stale = fakeHandle('run-0');
    const live = fakeHandle('run-1');
    openMock.mockResolvedValueOnce(stale).mockResolvedValueOnce(live);

    await service.openReadOnly(`/tmp/repos/${jobId}-0`, jobId);
    const liveHandle = await service.openReadOnly(
      `/tmp/repos/${jobId}-1`,
      jobId,
    );

    service.close(`/tmp/repos/${jobId}-0`);
    await Promise.resolve();

    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(live.close).not.toHaveBeenCalled();
    // The live run is still cached and still the same handle.
    expect(await service.openReadOnly(`/tmp/repos/${jobId}-1`, jobId)).toBe(
      liveHandle,
    );
  });

  it('does not cache a failed open', async () => {
    // A rejected promise left in the Map would poison every later open of that
    // path for the process's lifetime — one transient failure, and the run is
    // unrecoverable even though a retry would have worked.
    const path = '/tmp/repos/job-abc-0';
    openMock
      .mockRejectedValueOnce(new Error('disk gone'))
      .mockResolvedValueOnce(fakeHandle('run-0'));

    await expect(service.openReadOnly(path, 'job-abc')).rejects.toThrow(
      'disk gone',
    );
    await expect(service.openReadOnly(path, 'job-abc')).resolves.toMatchObject({
      tag: 'run-0',
    });
    expect(openMock).toHaveBeenCalledTimes(2);
  });
});
