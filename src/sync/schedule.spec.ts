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

  it('runs an object as soon as its interval has passed, at ANY minute', () => {
    scheduler.lastIngestAt.set('ingest:customer', at(9, 0)); // offset 0
    jest.spyOn(Date, 'now').mockReturnValue(at(10, 0));
    expect(scheduler.dueJobs()).toContain('ingest:customer');

    // ...and still at 10:03, three minutes later.
    //
    // This assertion used to be the opposite, and that was the bug. A job was
    // eligible at exactly ONE minute per interval window, so losing that minute
    // to a sweep already in flight cost it a WHOLE interval. The ERP's gateway
    // log showed sales_order arriving every 30 minutes on a 15-minute setting
    // because sales_delivery, one minute ahead of it in the window, kept
    // overrunning into its slot.
    jest.spyOn(Date, 'now').mockReturnValue(at(10, 3));
    expect(scheduler.dueJobs()).toContain('ingest:customer');
  });

  it('retries the very next minute when a sweep stole the slot', () => {
    // sales_delivery starts at :06 and overruns; sales_order's :07 tick is
    // skipped because a sweep is in flight. At :08 it must still be due — not
    // fifteen minutes later.
    scheduler.lastIngestAt.set('ingest:sales_order', at(9, 22));
    settings.ERP_INTERVAL_SALES_ORDER = 15;
    jest.spyOn(Date, 'now').mockReturnValue(at(9, 37)); // its own minute, missed
    expect(scheduler.dueJobs()).toContain('ingest:sales_order');
    jest.spyOn(Date, 'now').mockReturnValue(at(9, 38)); // the one after
    expect(scheduler.dueJobs()).toContain('ingest:sales_order');
    jest.spyOn(Date, 'now').mockReturnValue(at(9, 41));
    expect(scheduler.dueJobs()).toContain('ingest:sales_order');
  });

  it('puts the object that is ON TIME first, and still lists the stragglers', () => {
    settings.ERP_INGEST_INTERVAL_MINUTES = 15;
    jest.spyOn(Date, 'now').mockReturnValue(at(10, 0));
    // customer ran recently; sales_order has been waiting far longer.
    scheduler.lastIngestAt.set('ingest:customer', at(9, 44));
    scheduler.lastIngestAt.set('ingest:sales_order', at(9, 10));
    scheduler.lastIngestAt.set('ingest:collection', at(9, 30));
    for (const j of ['ingest:sales_delivery', 'ingest:customer_credit', 'ingest:sales_return',
      'ingest:ar_refund', 'ingest:other_receivable', 'ingest:ar_transfer']) {
      scheduler.lastIngestAt.set(j, at(9, 59));
    }
    const due = scheduler.dueJobs();
    // customer sits exactly on its 10:00 slot, so it leads — being on time is
    // what earns the tick. sales_order has waited far longer and is still in
    // the list; it takes one of the six minutes an hour nobody is scheduled for.
    expect(due[0]).toBe('ingest:customer');
    expect(due).toContain('ingest:sales_order');
  });

  it('still lets customer go first on a fresh process, for the Guid bridge', () => {
    // Nothing has run, so everything ties — schedule order decides, and the
    // customer sweep is what fills erp_raw.customer_link that the document
    // objects resolve against.
    expect(scheduler.dueJobs()[0]).toBe('ingest:customer');
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

/**
 * The cadence holds to the clock, not to the last run.
 *
 * Measured on 2026-11-09 after the first fix: sales_order started at 15:49,
 * 16:04, 16:23, 16:43, 17:03 — fifteen minutes, then nineteen, then twenty,
 * then twenty. Due time was `last start + interval`, so a run delayed by
 * contention became the base for the next and the lateness compounded until the
 * feed had quietly halved its rate again.
 */
describe('SyncScheduler cadence is anchored to the clock', () => {
  let settings: Record<string, unknown>;
  let scheduler: any;

  const at = (hh: number, mm: number, ss = 0) =>
    new Date(2026, 10, 9, hh, mm, ss).getTime();

  beforeEach(() => {
    settings = { ERP_INGEST_INTERVAL_MINUTES: 15, SYNC_ENABLED: true };
    const raw = { lastSuccessByJob: () => Promise.resolve(new Map()) };
    const config = { get: (k: string) => settings[k] } as never;
    scheduler = new SyncScheduler({} as never, {} as never, raw as never, config);
  });

  afterEach(() => jest.restoreAllMocks());

  it('does not move the next target when a run starts late', () => {
    // sales_order's grid at interval 15, offset 12: :12, :27, :42, :57.
    // It was blocked at :12 and only got away at :15.
    scheduler.lastIngestAt.set('ingest:sales_order', at(10, 15));

    // Not due again at :26 — its slot has not come round.
    jest.spyOn(Date, 'now').mockReturnValue(at(10, 26));
    expect(scheduler.dueJobs()).not.toContain('ingest:sales_order');

    // Due at :27, the next point on the grid. The late start did NOT push this
    // out to :30, which is what produced 19- and 20-minute gaps.
    jest.spyOn(Date, 'now').mockReturnValue(at(10, 27));
    expect(scheduler.dueJobs()).toContain('ingest:sales_order');
  });

  it('runs once per slot, not twice', () => {
    scheduler.lastIngestAt.set('ingest:sales_order', at(10, 27, 1));
    jest.spyOn(Date, 'now').mockReturnValue(at(10, 28));
    expect(scheduler.dueJobs()).not.toContain('ingest:sales_order');
    jest.spyOn(Date, 'now').mockReturnValue(at(10, 41));
    expect(scheduler.dueJobs()).not.toContain('ingest:sales_order');
  });

  it('keeps every object on its own fifteen-minute grid', () => {
    const slots = (offset: number) =>
      [0, 1, 2, 3].map((n) => {
        const t = at(10, 0) + n * 15 * 60_000;
        const s = scheduler.slotStart(t + 14 * 60_000, 15, offset);
        return new Date(s).getMinutes();
      });
    // Four targets an hour, exactly fifteen minutes apart, for any offset.
    for (const offset of [0, 7, 14, 21, 28, 56]) {
      const minutes = slots(offset);
      const gaps = minutes.map((m, i) => (i === 0 ? 15 : (m - minutes[i - 1] + 60) % 60));
      expect(gaps.every((g) => g === 15)).toBe(true);
    }
  });

  it('still catches a feed up after a restart, before anything else', () => {
    jest.spyOn(Date, 'now').mockReturnValue(at(10, 3));
    // Nothing has run in this process: all nine are due at once.
    expect(scheduler.dueJobs()).toHaveLength(9);
    expect(scheduler.dueJobs()[0]).toBe('ingest:customer');
  });
});

/**
 * The tick belongs to the job that is ON TIME.
 *
 * Most-overdue-first sounds like the fair rule and is the wrong one: the job
 * sitting exactly on its slot is the LEAST overdue in the list, so it lost
 * every time something else was running late — and the job that was on time is
 * the one knocked off its grid. Seen at 17:22 on 2026-11-09, where
 * other_receivable (three minutes late) took the tick that belonged to
 * sales_order (due that very minute), which then did not run until 17:32.
 */
describe('SyncScheduler gives the tick to the job at its slot', () => {
  let settings: Record<string, unknown>;
  let scheduler: any;
  const at = (hh: number, mm: number, ss = 0) =>
    new Date(2026, 10, 9, hh, mm, ss).getTime();

  beforeEach(() => {
    settings = { ERP_INGEST_INTERVAL_MINUTES: 15, SYNC_ENABLED: true };
    const raw = { lastSuccessByJob: () => Promise.resolve(new Map()) };
    scheduler = new SyncScheduler({} as never, {} as never, raw as never,
      { get: (k: string) => settings[k] } as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('prefers the object whose slot is this minute over one running late', () => {
    // other_receivable: offset 5  -> slot minutes :05 :20 :35 :50 — late since :20.
    // sales_order:      offset 12 -> slot minutes :12 :27 :42 :57 — due right now.
    scheduler.lastIngestAt.set('ingest:other_receivable', at(10, 10));
    scheduler.lastIngestAt.set('ingest:sales_order', at(10, 14));
    for (const j of ['ingest:customer', 'ingest:collection', 'ingest:sales_delivery',
      'ingest:customer_credit', 'ingest:sales_return', 'ingest:ar_refund',
      'ingest:ar_transfer']) {
      scheduler.lastIngestAt.set(j, at(10, 26));
    }

    jest.spyOn(Date, 'now').mockReturnValue(at(10, 27));
    const due = scheduler.dueJobs();
    expect(due).toContain('ingest:other_receivable'); // still due, just not first
    expect(due[0]).toBe('ingest:sales_order');
  });

  it('still serves the late job on a minute nobody is scheduled for', () => {
    scheduler.lastIngestAt.set('ingest:other_receivable', at(10, 10));
    for (const j of ['ingest:customer', 'ingest:sales_order', 'ingest:collection',
      'ingest:sales_delivery', 'ingest:customer_credit', 'ingest:sales_return',
      'ingest:ar_refund', 'ingest:ar_transfer']) {
      scheduler.lastIngestAt.set(j, at(10, 27));
    }
    // :28 is not a slot minute for any object (slots are 0,2,3,4,5,6,7,9,12),
    // so the straggler gets it.
    jest.spyOn(Date, 'now').mockReturnValue(at(10, 28));
    expect(scheduler.dueJobs()[0]).toBe('ingest:other_receivable');
  });

  it('keeps restart catch-up ahead of everything, customer first', () => {
    jest.spyOn(Date, 'now').mockReturnValue(at(10, 22));
    expect(scheduler.dueJobs()[0]).toBe('ingest:customer');
  });
});
