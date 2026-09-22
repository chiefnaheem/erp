import { SyncScheduler } from './sync.scheduler';

/**
 * Per-object scheduling.
 *
 * The ERP's own analysis of the 331 errors: requests arriving ~every 2s against a
 * ~60s response time, backlogging their server. Eight sweeps starting together on
 * one cron was the shape of that. These pin the two properties that fix it —
 * separate cadences, and never more than one sweep launched per tick.
 */
describe('SyncScheduler per-object schedule', () => {
  let settings: Record<string, unknown>;
  let scheduler: any;
  /** Whatever the freshness check reads: job → when it last finished cleanly. */
  let lastSuccess: Map<string, Date>;
  let raw: { lastSuccessByJob: () => Promise<Map<string, Date>> };

  const at = (hh: number, mm: number) => new Date(2026, 7, 28, hh, mm, 0).getTime();

  beforeEach(() => {
    settings = { ERP_INGEST_INTERVAL_MINUTES: 60, SYNC_ENABLED: true };
    lastSuccess = new Map();
    raw = { lastSuccessByJob: () => Promise.resolve(lastSuccess) };
    const config = { get: (k: string) => settings[k] } as never;
    scheduler = new SyncScheduler({} as never, {} as never, raw as never, config);
  });

  afterEach(() => jest.restoreAllMocks());

  it('treats every object as due on a fresh process, so nothing is missed', () => {
    expect(scheduler.dueJobs()).toHaveLength(9);
  });

  it('gives each object its own start minute, so two never begin together', () => {
    const offsets = scheduler.ingestSchedule.map((s: any) => s.offsetMinutes);
    expect(new Set(offsets).size).toBe(offsets.length);
  });

  it('does not re-run an object before its interval has elapsed', () => {
    jest.spyOn(Date, 'now').mockReturnValue(at(9, 0));
    scheduler.lastIngestAt.set('ingest:customer', at(9, 0));

    jest.spyOn(Date, 'now').mockReturnValue(at(9, 30)); // 30 min later, interval 60
    expect(scheduler.dueJobs()).not.toContain('ingest:customer');
  });

  it('runs an object again at its own minute once the interval has passed', () => {
    scheduler.lastIngestAt.set('ingest:customer', at(9, 0)); // offset 0
    jest.spyOn(Date, 'now').mockReturnValue(at(10, 0));
    expect(scheduler.dueJobs()).toContain('ingest:customer');

    // ...but not at some other minute of the hour
    jest.spyOn(Date, 'now').mockReturnValue(at(10, 3));
    expect(scheduler.dueJobs()).not.toContain('ingest:customer');
  });

  it('honours a per-object interval override', () => {
    settings.ERP_INTERVAL_SALES_ORDER = 30; // sales orders change constantly
    scheduler.lastIngestAt.set('ingest:sales_order', at(9, 0));
    // offset 7, interval 30 -> due at minute 7 and 37
    jest.spyOn(Date, 'now').mockReturnValue(at(9, 37));
    expect(scheduler.dueJobs()).toContain('ingest:sales_order');
  });

  it('launches at most ONE sweep per tick even when several are due', async () => {
    const runStage = jest.spyOn(scheduler, 'runStage').mockResolvedValue(true);
    expect(scheduler.dueJobs().length).toBeGreaterThan(1);
    await scheduler.ingestTick();
    expect(runStage).toHaveBeenCalledTimes(1);
  });

  it('runs nothing at all when SYNC_ENABLED is false', async () => {
    settings.SYNC_ENABLED = false;
    const runStage = jest.spyOn(scheduler, 'runStage').mockResolvedValue(true);
    await scheduler.ingestTick();
    expect(runStage).not.toHaveBeenCalled();
  });

  it('keeps a job DUE when its tick stood down for the lock', async () => {
    // A long sweep holds the lock, so this tick does not run.
    jest.spyOn(scheduler, 'runStage').mockResolvedValue(false);
    await scheduler.ingestTick();
    // Still due — otherwise a busy object that keeps losing the race would wait
    // a full interval every time.
    expect(scheduler.dueJobs()).toContain('ingest:customer');
    expect(scheduler.lastIngestAt.size).toBe(0);
  });

  it('marks a job as run only when the sweep actually executed', async () => {
    jest.spyOn(scheduler, 'runStage').mockResolvedValue(true);
    await scheduler.ingestTick();
    expect(scheduler.lastIngestAt.has('ingest:customer')).toBe(true);
  });

  it('does not dispatch anything while a sweep is already in flight', async () => {
    const runStage = jest
      .spyOn(scheduler, 'runStage')
      .mockImplementation(() => new Promise(() => {})); // never settles: still sweeping

    void scheduler.ingestTick(); // starts and stays in flight
    await Promise.resolve();
    await scheduler.ingestTick(); // the next minute's tick
    await scheduler.ingestTick();

    expect(runStage).toHaveBeenCalledTimes(1);
  });

  it('is due at its own minute even when the interval is short by seconds', () => {
    // The real bug: `last` is stamped when the sweep starts, a second or two
    // after the tick. At the next matching minute the elapsed time is 59.97
    // minutes, which was judged "not due" — so a 60-minute job ran every 120.
    // customer_credit is the object this actually happened to: interval 60,
    // start minute 28.
    scheduler.lastIngestAt.set('ingest:customer_credit', at(10, 28) + 2000); // started :28:02
    jest.spyOn(Date, 'now').mockReturnValue(at(11, 28)); // tick at :28:00, 59.97m later
    expect(scheduler.dueJobs()).toContain('ingest:customer_credit');
  });

  it('still refuses to run well before the interval is up', () => {
    scheduler.lastIngestAt.set('ingest:customer_credit', at(10, 28));
    jest.spyOn(Date, 'now').mockReturnValue(at(10, 50)); // only 22 minutes later
    expect(scheduler.dueJobs()).not.toContain('ingest:customer_credit');
  });
});

/**
 * Freshness.
 *
 * A distributor's credit sat two days out of date and nothing reported it: the
 * sweep was not running, and the only "last run" we published lived in memory
 * and reset on restart. These pin the properties that make a stalled feed
 * visible.
 */
describe('SyncScheduler freshness', () => {
  let settings: Record<string, unknown>;
  let lastSuccess: Map<string, Date>;
  let scheduler: any;

  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
  const feed = (report: any, job: string) =>
    report.feeds.find((f: any) => f.job === job);

  beforeEach(() => {
    settings = {
      ERP_INGEST_INTERVAL_MINUTES: 60,
      ERP_INTERVAL_CUSTOMER_CREDIT: 30,
      ERP_STALE_AFTER_MULTIPLE: 3,
      SYNC_ENABLED: true,
    };
    lastSuccess = new Map();
    const raw = { lastSuccessByJob: () => Promise.resolve(lastSuccess) };
    const config = { get: (k: string) => settings[k] } as never;
    scheduler = new SyncScheduler({} as never, {} as never, raw as never, config);
  });

  it('reads the recorded run history, not the in-memory map — so a restart does not erase it', async () => {
    lastSuccess.set('ingest:customer_credit', minutesAgo(10));
    // lastIngestAt is what a fresh process has: empty.
    expect(scheduler.lastIngestAt.size).toBe(0);

    const report = await scheduler.freshness();
    expect(feed(report, 'ingest:customer_credit').stale).toBe(false);
    expect(feed(report, 'ingest:customer_credit').minutesSince).toBe(10);
  });

  it('flags the feed that actually went stale, and leaves the healthy ones alone', async () => {
    // The real case: credit last swept two days before it was noticed.
    lastSuccess.set('ingest:customer_credit', minutesAgo(60 * 48));
    lastSuccess.set('ingest:customer', minutesAgo(20));

    const report = await scheduler.freshness();
    expect(feed(report, 'ingest:customer_credit').stale).toBe(true);
    expect(feed(report, 'ingest:customer').stale).toBe(false);
  });

  it('judges lateness against each feed\'s own interval, not one fixed age', async () => {
    // 100 minutes: late for a 30-minute feed (threshold 90), fine for a
    // 60-minute one (threshold 180).
    lastSuccess.set('ingest:customer_credit', minutesAgo(100)); // every 30m
    lastSuccess.set('ingest:customer', minutesAgo(100)); // every 60m

    const report = await scheduler.freshness();
    expect(feed(report, 'ingest:customer_credit').stale).toBe(true);
    expect(feed(report, 'ingest:customer').stale).toBe(false);
  });

  it('does not cry wolf over a single skipped cycle', async () => {
    lastSuccess.set('ingest:customer_credit', minutesAgo(45)); // every 30m, one missed
    const report = await scheduler.freshness();
    expect(feed(report, 'ingest:customer_credit').stale).toBe(false);
  });

  it('treats a feed that has never completed a run as stale, not as blank', async () => {
    const report = await scheduler.freshness();
    expect(feed(report, 'ingest:customer_credit').lastSuccessAt).toBeNull();
    expect(feed(report, 'ingest:customer_credit').stale).toBe(true);
  });

  it('watches the projection too — fresh raw data that never lands is just as wrong', async () => {
    const report = await scheduler.freshness();
    expect(feed(report, 'project:customer')).toBeDefined();
  });

  it('reports whether the sync is paused, so a stale feed can be explained', async () => {
    settings.SYNC_ENABLED = false;
    const report = await scheduler.freshness();
    expect(report.syncEnabled).toBe(false);
    expect(report.staleCount).toBeGreaterThan(0);
  });
});

/**
 * Lease recovery on startup.
 *
 * A fresh worker must clear the lease a DEAD predecessor left behind, and must
 * not touch one a LIVE process is holding. Releasing a live holder's lease is
 * what let two sweeps of the same object run together on 2026-09-22 — and
 * because each sweep clears the other's reconciliation tags, the one that
 * finished second deleted 400 customers that were present in the ERP the whole
 * time.
 */
describe('SyncScheduler lease recovery', () => {
  const build = () => {
    const config = { get: () => undefined } as never;
    return new SyncScheduler({} as never, {} as never, {} as never, config) as any;
  };

  it('treats a lease held by a process that is still running as LIVE', () => {
    // Our own pid is certainly alive; borrow it as a stand-in for the worker.
    const alive = `host:${process.pid + 0}`;
    const s = build();
    // Same-pid is special-cased as "our own previous incarnation", so use a
    // different live pid: the parent process, which started us.
    const parent = process.ppid;
    expect(s.ownerStillRunning(`host:${parent}`)).toBe(true);
    expect(alive).toContain('host:');
  });

  it('treats a lease held by a vanished process as releasable', () => {
    // A pid that cannot exist.
    expect(build().ownerStillRunning('host:2147483647')).toBe(false);
  });

  it('releases its own previous incarnation, which by definition is gone', () => {
    expect(build().ownerStillRunning(`host:${process.pid}`)).toBe(false);
  });

  it('treats an unreadable owner as gone rather than blocking forever', () => {
    expect(build().ownerStillRunning(null)).toBe(false);
    expect(build().ownerStillRunning('host:not-a-pid')).toBe(false);
  });
});
