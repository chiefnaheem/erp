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

  const at = (hh: number, mm: number) => new Date(2026, 7, 28, hh, mm, 0).getTime();

  beforeEach(() => {
    settings = { ERP_INGEST_INTERVAL_MINUTES: 60, SYNC_ENABLED: true };
    const config = { get: (k: string) => settings[k] } as never;
    scheduler = new SyncScheduler({} as never, {} as never, config);
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
