import { hostname } from 'node:os';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RawRepository } from '../raw/raw.repository';
import { SyncService } from './sync.service';

const INGEST_LOCK = 'ingest';
const PROJECT_LOCK = 'projection';

@Injectable()
export class SyncScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(SyncScheduler.name);
  private readonly host = hostname();
  private readonly owner = `${hostname()}:${process.pid}`;
  private tickCount = 0;
  private readonly bootTime = Date.now();
  /**
   * The last freshness report, so /health can report a stalled feed without
   * running a query on every probe. Null until the first check has run.
   */
  private lastFreshness: { checkedAt: string; stale: string[] } | null = null;

  constructor(
    private readonly sync: SyncService,
    private readonly prisma: PrismaService,
    private readonly raw: RawRepository,
    private readonly config: ConfigService,
  ) {}

  /**
   * On startup, recover from a previous run of THIS worker that died mid-cycle.
   *
   * A hard kill (Ctrl-C, redeploy, crash) leaves the lease held until it expires
   * — up to SYNC_LOCK_MINUTES — during which every tick stands down. So a fresh
   * process releases the leases whose owner is GONE, and closes out that owner's
   * dangling RUNNING runs.
   *
   * "Whose owner is gone" is doing real work in that sentence: see the note in
   * onApplicationBootstrap for what releasing a LIVE process's lease cost.
   */

  /**
   * Is the process that took this lease still alive?
   *
   * signal 0 does no work — it only asks the OS whether the pid exists and is
   * signalable. A pid we cannot see (EPERM: another user) counts as ALIVE, which
   * is the safe direction: wrongly leaving a lease costs one cycle of waiting,
   * wrongly releasing one costs deleted rows.
   */
  private ownerStillRunning(lockedBy: string | null): boolean {
    const pid = Number(lockedBy?.split(':').pop());
    if (!Number.isInteger(pid) || pid <= 0) return false; // unparsable: treat as gone
    if (pid === process.pid) return false; // our own previous incarnation
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    // ⚠️ Only leases whose owning PROCESS IS GONE. This used to release every
    // lease bearing this hostname, on the reasoning that a fresh process here
    // means the previous one is dead. That is false the moment a SECOND process
    // starts beside a live worker — which ops/run-job.js does every time it
    // boots the application context. The running sweep then lost its lease, a
    // second sweep of the same object started alongside it, and because each
    // sweep clears the other's reconciliation tags, whichever finished second
    // deleted rows that were perfectly present in the ERP. That took
    // raw_customer from 3,827 rows to 3,427 on 2026-09-22.
    //
    // locked_by is `${hostname}:${pid}`, so the owner can simply be asked
    // whether it is still running.
    const candidates = await this.prisma.$queryRaw<
      { name: string; locked_by: string | null }[]
    >`
      SELECT name, locked_by FROM erp_raw.sync_lock
      WHERE name IN (${INGEST_LOCK}, ${PROJECT_LOCK})
        AND locked_by LIKE ${this.host + ':%'}
        AND locked_until > now()
    `;

    const dead = candidates
      .filter(({ locked_by }) => !this.ownerStillRunning(locked_by))
      .map(({ name }) => name);

    let released = 0;
    for (const name of dead) {
      released += await this.prisma.$executeRaw`
        UPDATE erp_raw.sync_lock SET locked_until = now()
        WHERE name = ${name} AND locked_until > now()
      `;
    }

    for (const { name, locked_by } of candidates) {
      if (!dead.includes(name)) {
        this.logger.warn(
          `leaving the ${name} lease alone — ${locked_by} is still running. ` +
            `Another process on this host is mid-sweep.`,
        );
      }
    }

    if (released > 0) {
      this.logger.warn(
        `released ${released} stale sync lock(s) held by a previous process on ${this.host}`,
      );
    }

    // Any run still marked RUNNING at startup belongs to a dead process — close
    // it out so the audit trail and any "is a sync in progress?" check stay honest.
    const closed = await this.prisma.$executeRaw`
      UPDATE erp_raw.sync_run
      SET status = 'FAILED', finished_at = now(),
          error = COALESCE(error, 'process restarted before this run finished')
      WHERE status = 'RUNNING'
    `;
    if (closed > 0) {
      this.logger.warn(`marked ${closed} interrupted sync_run row(s) as FAILED`);
    }
  }

  /**
   * Interval polling.
   *
   * Ingest is now per-object and incremental (see ingestSchedule below); the ERP
   * pays for one object's changed rows at a time rather than a full re-read of
   * everything on one clock.
   *
   * Every stage below is logged and timed independently, and tagged with a tick
   * id (e.g. "tick #7"), so a failure tells you exactly WHICH stage broke —
   * acquiring the lock, running the cycle, or releasing — rather than surfacing a
   * bare Prisma error with no context.
   */
  /**
   * Per-object ingest schedule.
   *
   * Each ERP interface gets its OWN cadence and its own start minute. Two reasons:
   *
   *  1. The ERP asked us to. Their analysis of the 331 errors found requests
   *     arriving ~every 2s against a ~60s response time, backlogging their server.
   *     Eight sweeps that all began at :00 were the shape of that burst.
   *  2. The objects are not equally busy. Customers change rarely; sales orders
   *     and collections change constantly. Sweeping them on the same clock wastes
   *     calls on the quiet ones.
   *
   * `offsetMinutes` staggers the start so two objects never begin together, and
   * the dispatcher runs at most ONE sweep per tick, so only one is ever in flight.
   */
  private readonly ingestSchedule: {
    job: string;
    configKey: string;
    offsetMinutes: number;
  }[] = [
    // ── Slot minutes, and why these numbers ────────────────────────────────
    //
    // At a 15-minute interval a job's slot is offsetMinutes % 15, so these lay
    // nine objects across a fifteen-minute window. They used to be 0, 7, 14, 21,
    // 28, 35, 42, 49, 56 — which modulo 15 is 0, 7, 14, 6, 13, 5, 12, 4, 11, and
    // that put sales_delivery (6) one minute ahead of sales_order (7).
    //
    // One minute is not enough. sales_delivery is the one object whose turn
    // regularly runs the full ERP_SWEEP_MAX_MINUTES — it is the big backfill —
    // so it was still sweeping when sales_order's slot came round, every single
    // cycle. Measured 2026-11-09: sales_delivery on its slot at 18:21, and
    // sales_order pushed from 18:22 to 18:24.
    //
    // So the long-running object gets THREE clear minutes after it, and the
    // quick ones (3-30s each) sit a minute apart where that is harmless.
    { job: 'ingest:customer', configKey: 'ERP_INTERVAL_CUSTOMER', offsetMinutes: 0 },
    { job: 'ingest:collection', configKey: 'ERP_INTERVAL_COLLECTION', offsetMinutes: 2 },
    { job: 'ingest:customer_credit', configKey: 'ERP_INTERVAL_CUSTOMER_CREDIT', offsetMinutes: 3 },
    { job: 'ingest:sales_return', configKey: 'ERP_INTERVAL_SALES_RETURN', offsetMinutes: 4 },
    { job: 'ingest:other_receivable', configKey: 'ERP_INTERVAL_OTHER_RECEIVABLE', offsetMinutes: 5 },
    { job: 'ingest:ar_refund', configKey: 'ERP_INTERVAL_AR_REFUND', offsetMinutes: 6 },
    { job: 'ingest:ar_transfer', configKey: 'ERP_INTERVAL_AR_TRANSFER', offsetMinutes: 7 },
    { job: 'ingest:sales_delivery', configKey: 'ERP_INTERVAL_SALES_DELIVERY', offsetMinutes: 9 },
    { job: 'ingest:sales_order', configKey: 'ERP_INTERVAL_SALES_ORDER', offsetMinutes: 12 },
  ];

  /** When each object last STARTED a sweep, so intervals are measured from a run
   *  rather than from the clock. Empty after a restart — see dueJobs(). */
  private readonly lastIngestAt = new Map<string, number>();

  /**
   * When each object's RECENT-WINDOW REFRESH last ran in this process.
   *
   * Separate from lastIngestAt on purpose: a refresh is not a sweep and must
   * not stand in for one (see refreshTick).
   */
  private readonly lastRefreshAt = new Map<string, number>();

  /**
   * When this worker started. The refresh lane's starvation clock runs from
   * here as well as from its last run, so a restart cannot let it preempt the
   * restart catch-up.
   */
  private readonly startedAt = Date.now();

  /** A sweep is running in THIS process. Sweeps can outlast their interval (the
   *  customer sweep takes ~90s, collections far longer), and without this the
   *  dispatcher re-picks the same job every minute just to lose the lock race and
   *  log a stand-down. The DB lock still guards across processes. */
  private ingestInFlight = false;

  /**
   * Fires every minute, but does almost nothing: it picks at most one object whose
   * interval has elapsed and sweeps that one. A quiet minute costs a Map lookup.
   */
  @Cron('0 * * * * *', { name: 'erp-ingest' })
  async ingestTick(): Promise<void> {
    if (!this.config.get<boolean>('SYNC_ENABLED')) return;

    if (this.ingestInFlight) return;

    // ⚠️ Claimed SYNCHRONOUSLY, before the first await. The in-flight guard
    // used to be taken further down, next to the sweep it protects — which was
    // fine while nothing was awaited above it, and stopped being fine the moment
    // the refresh lane added an await to decide whether it was starving. Two
    // ticks could then both pass the guard and dispatch, which is precisely the
    // thing ERP_INGEST_CONCURRENCY=1 exists to prevent.
    this.ingestInFlight = true;
    try {
      const due = this.dueJobs();

      // Nothing to sweep: the idle tick is where the recent-window refresh
      // normally goes, so it never takes a tick a sweep wanted.
      if (due.length === 0) {
        await this.refreshTick();
        return;
      }

      // ⚠️ But idle ticks are not guaranteed. The estimate was "six of every
      // fifteen minutes are free", and in practice the heavy objects run to
      // ERP_SWEEP_MAX_MINUTES and something is due on nearly every tick — so a
      // lane that only ever takes an idle tick can be starved indefinitely,
      // which is no better than not having it. Once it is two intervals overdue
      // it takes a tick in front of the sweeps: one turn lost every twelve hours,
      // against a feed going days without the only check that can see a change
      // the ERP made without advancing LastModifiedDate.
      if (await this.refreshTick(true)) return;

      // ONE per tick. Several may be due at once (notably right after a restart);
      // running them a minute apart is exactly the spreading the ERP asked for.
      const job = due[0];
      this.logger.log(
        `ingest tick — ${job}` +
          (due.length > 1 ? ` (${due.length - 1} more due, one per minute)` : ''),
      );

      // Stamp only if the sweep really ran. A tick that stood down (a longer
      // sweep still holds the lock) must stay due, or a busy object that keeps
      // colliding with a slow one would silently wait a full interval each time
      // it lost.
      const ran = await this.runStage(INGEST_LOCK, () => this.sync.runIngestJob(job));
      if (ran) this.lastIngestAt.set(job, Date.now());
    } finally {
      this.ingestInFlight = false;
    }
  }

  // ─── The recent-window refresh ───────────────────────────────────────────
  //
  // ⚠️ WHY THIS LANE EXISTS. Every lane that keeps a feed fresh — the
  // incremental sweep and the catch-up lane — asks the ERP the same question:
  // "what changed since <watermark>", filtered on LastModifiedDate. That is
  // sound only while the ERP advances LastModifiedDate whenever a row changes,
  // and it does not always do so.
  //
  // Measured on 2026-11-19 over the two days since the catch-up fix: of 2,472
  // genuine updates to existing raw_sales_order rows, 2,434 were detected within
  // ~16 minutes — and 38 were detected 10 to 27 DAYS after the LastModifiedDate
  // they carry. Every one of those 38 had BUSINESS_QTY = DELIVERED_BUSINESS_QTY:
  // a delivery had been posted against the order, and the ERP updated the
  // delivered quantity in place WITHOUT touching LastModifiedDate. No
  // LastModifiedDate query can ever see those rows.
  //
  // The only thing that found them was the full sweep, which reads every row and
  // compares content hashes — but a full sweep runs every ERP_FULL_SWEEP_DAYS (7)
  // and takes ~30 hours on sales_order, so a silent change waited up to a week.
  // To a distributor that is "my order never updated".
  //
  // So: re-read a RECENT WINDOW often and cheaply. A 30-day DOC_DATE window on
  // sales_order is 15,582 rows — 16 pages against the full sweep's 1,158 — and
  // it catches 33 of those 38. It reuses backfill(), which upserts through the
  // ordinary key and deliberately touches no page cursor, no watermark and no
  // reconciliation, so the running sweep resumes exactly where it paused and
  // unchanged rows cost nothing (the content hash makes them no-ops).
  //
  // Old documents stay with the full sweep. A receipt from 2023 being touched by
  // a batch process is not what anyone is waiting on.

  /** Objects to re-read over a recent window. Unknown names are ignored. */
  private refreshJobs(): string[] {
    const configured =
      this.config.get<string>('ERP_REFRESH_JOBS') ?? 'ingest:sales_order';
    const known = new Set(this.ingestJobNames());
    return configured
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0 && known.has(name));
  }

  /** The window to re-read: the last ERP_REFRESH_WINDOW_DAYS of DOC_DATE. */
  private refreshWindow(): { field: string; from: string; to: string } {
    const days = Math.max(1, this.config.get<number>('ERP_REFRESH_WINDOW_DAYS') ?? 45);
    const field = this.config.get<string>('ERP_REFRESH_FIELD') ?? 'DOC_DATE';
    const day = (at: Date) => at.toISOString().slice(0, 10);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    // Whole days, inclusive at both ends. DOC_DATE is a date-at-midnight in this
    // feed, and a day of slack either side of a 45-day window costs nothing.
    return { field, from: `${day(from)} 00:00:00`, to: `${day(to)} 23:59:59` };
  }

  /**
   * The object whose refresh is due, or null.
   *
   * Seeded from erp_raw.sync_run rather than from memory alone, so a restart
   * does not re-run every window: the lane is cheap but not free, and a worker
   * that restarts repeatedly should not re-read the same 16 pages each time.
   */
  private async dueRefresh(): Promise<{ job: string; starving: boolean } | null> {
    const everyMin = this.config.get<number>('ERP_REFRESH_EVERY_MINUTES') ?? 360;
    if (everyMin <= 0) return null; // 0 disables the lane outright

    const jobs = this.refreshJobs();
    if (jobs.length === 0) return null;

    const now = Date.now();
    const lastSuccess = await this.raw.lastSuccessByJob();
    // Past this, the lane has waited long enough that it stops being polite.
    const starveAfterMs = everyMin * 2 * 60_000;

    const candidates = jobs
      .map((job, index) => {
        // Stagger by position so two refreshes never fall on one minute.
        const slot = this.slotStart(now, everyMin, index);
        const last =
          this.lastRefreshAt.get(job) ?? lastSuccess.get(`${job}:backfill`)?.getTime();
        // Measured from the LATER of "last refresh" and "worker start", so a
        // restart does not let the lane barge in front of the restart catch-up —
        // nine objects all due at once is exactly when sweeps matter most.
        const waitingSince = Math.max(last ?? 0, this.startedAt);
        return {
          job,
          slot,
          due: last === undefined || last < slot,
          starving: now - waitingSince > starveAfterMs,
        };
      })
      .filter(({ due }) => due)
      .sort((a, b) => Number(b.starving) - Number(a.starving) || b.slot - a.slot);

    const first = candidates[0];
    return first ? { job: first.job, starving: first.starving } : null;
  }

  /**
   * Re-read one object's recent window, on an otherwise-idle ingest tick.
   *
   * Runs under the SAME in-flight guard and ingest lease as a sweep, which is
   * the point: this must never put a second caller on the ERP beside a sweep.
   * The external-integration licence is concurrency-limited (CE66044 returns an
   * EMPTY body when it is exhausted), so an extra parallel reader would not just
   * be impolite, it would make the sweep fail blind.
   */
  /**
   * Re-read one object's recent window. Returns whether it took the tick.
   *
   * The caller already holds the in-flight guard, so this does not touch it.
   * `starvingOnly` is how a tick a sweep wanted is offered: only a lane that is
   * two intervals overdue may take it.
   */
  private async refreshTick(starvingOnly = false): Promise<boolean> {
    const due = await this.dueRefresh();
    if (!due) return false;
    if (starvingOnly && !due.starving) return false;

    const { job } = due;
    const window = this.refreshWindow();
    this.logger.log(
      `refresh tick — ${job} (${window.field} ${window.from} .. ${window.to})` +
        (starvingOnly ? ' — OVERDUE, taking this tick ahead of the sweeps' : ''),
    );

    // Stamped even when the backfill FAILS. runStage returns "the stage ran",
    // not "the work succeeded", and that is the behaviour we want here: a window
    // the ERP refuses to filter on must not be retried every idle minute. It is
    // recorded FAILED in erp_raw.sync_run and waits for the next interval.
    const ran = await this.runStage(INGEST_LOCK, () =>
      this.sync.runBackfillJob(job, window),
    );
    if (ran) this.lastRefreshAt.set(job, Date.now());
    return true;
  }

  // ─── On-demand triggers ──────────────────────────────────────────────────
  // Used by the /sync endpoints so a run can be forced without waiting for the
  // schedule. They go through the SAME in-flight guard and DB lock as the cron,
  // which is the point: a manual trigger must never put a second sweep on the
  // ERP alongside a scheduled one. (An earlier attempt ran the sweep in its own
  // process and did exactly that.)

  /** Names of the objects that can be swept. */
  ingestJobNames(): string[] {
    return this.ingestSchedule.map((s) => s.job);
  }

  /** What the scheduler is doing right now, for the /sync/status endpoint. */
  status(): Record<string, unknown> {
    const defaultInterval =
      this.config.get<number>('ERP_INGEST_INTERVAL_MINUTES') ?? 60;
    return {
      sweepInProgress: this.ingestInFlight,
      due: this.dueJobs(),
      objects: this.ingestSchedule.map(({ job, configKey, offsetMinutes }) => {
        const last = this.lastIngestAt.get(job);
        return {
          job,
          everyMinutes: this.config.get<number>(configKey) ?? defaultInterval,
          startsAtMinute: offsetMinutes,
          lastRun: last ? new Date(last).toISOString() : null,
        };
      }),
      // The recent-window refresh: what it covers and when each object last had
      // one. See refreshTick — this is the lane that catches ERP changes made
      // without advancing LastModifiedDate.
      refresh: {
        everyMinutes: this.config.get<number>('ERP_REFRESH_EVERY_MINUTES') ?? 360,
        window: this.refreshWindow(),
        objects: this.refreshJobs().map((job) => {
          const last = this.lastRefreshAt.get(job);
          return { job, lastRun: last ? new Date(last).toISOString() : null };
        }),
      },
    };
  }

  /**
   * How long since each feed last completed a run, and whether that is too long.
   *
   * ─── Why this exists ───────────────────────────────────────────────────────
   *
   * On 2026-09-17 a distributor's credit was two days out of date — the ERP had
   * moved their Used Credit Limit by 145,000 and we were still publishing the
   * old figure. The sweep that keeps it current runs every thirty minutes and
   * had not run since the 15th, because the service was paused. Nothing said so.
   * Someone noticed by reading a number on a screen and not believing it.
   *
   * status() could not have told them: its `lastRun` is an in-memory Map that
   * empties on every restart, so a freshly restarted worker reports "never run"
   * for a feed that is perfectly healthy, and a paused one reports the same
   * thing for a feed that has genuinely stopped. This reads erp_raw.sync_run
   * instead, which survives restarts and records what actually happened.
   *
   * `stale` is the alarm: no successful run in ERP_STALE_AFTER_MULTIPLE times
   * the object's own interval. A multiple, not a fixed age, because a 30-minute
   * feed and a daily one are not late at the same point — and three of them,
   * so a single skipped cycle (a lock held, one ERP timeout) is not an alarm.
   */
  async freshness(): Promise<{
    checkedAt: string;
    staleCount: number;
    syncEnabled: boolean;
    feeds: {
      job: string;
      everyMinutes: number;
      lastSuccessAt: string | null;
      minutesSince: number | null;
      staleAfterMinutes: number;
      stale: boolean;
      /** Newest ERP timestamp this feed HOLDS (ERP clock), ingest feeds only. */
      newestDataAt?: string | null;
      /** Hours between that and now. Null when the feed keeps no watermark. */
      dataAgeHours?: number | null;
      /** True when the DATA has stood still, however healthy the job looks. */
      dataStale?: boolean;
    }[];
  }> {
    const defaultInterval =
      this.config.get<number>('ERP_INGEST_INTERVAL_MINUTES') ?? 60;
    const multiple = Math.max(2, this.config.get<number>('ERP_STALE_AFTER_MULTIPLE') ?? 3);
    const projectionMinutes =
      this.config.get<number>('ERP_PROJECTION_INTERVAL_MINUTES') ?? 3;
    const now = Date.now();

    const lastSuccess = await this.raw.lastSuccessByJob();
    // How recent the DATA is, not just the job. See watermarksByJob().
    const watermarks = await this.raw.watermarksByJob();
    const dataStaleHours = this.config.get<number>('ERP_DATA_STALE_HOURS') ?? 24;

    // The projection is checked too: a fresh raw table that never reaches
    // public.* leaves the app just as wrong as a stale sweep would.
    const feeds = [
      ...this.ingestSchedule.map(({ job, configKey }) => ({
        job,
        everyMinutes: this.config.get<number>(configKey) ?? defaultInterval,
      })),
      { job: 'project:customer', everyMinutes: projectionMinutes },
      { job: 'project:purchase', everyMinutes: projectionMinutes },
      { job: 'project:payment', everyMinutes: projectionMinutes },
    ];

    const rows = feeds.map(({ job, everyMinutes }) => {
      const at = lastSuccess.get(job) ?? null;
      const minutesSince = at ? Math.round((now - at.getTime()) / 60_000) : null;
      const staleAfterMinutes = everyMinutes * multiple;

      // The ERP's timestamps are its own clock, and 'YYYY-MM-DD HH:mm:ss' is
      // parsed here as UTC purely to get an age in hours. An hour or two of
      // offset does not matter against a threshold measured in days, and the
      // value is reported verbatim so a reader sees the ERP's own string.
      const newestDataAt = watermarks.get(job) ?? null;
      const parsed = newestDataAt
        ? new Date(`${newestDataAt.replace(' ', 'T')}Z`).getTime()
        : NaN;
      const dataAgeHours = Number.isNaN(parsed)
        ? null
        : Math.round(((now - parsed) / 3_600_000) * 10) / 10;

      return {
        job,
        everyMinutes,
        lastSuccessAt: at ? at.toISOString() : null,
        minutesSince,
        staleAfterMinutes,
        newestDataAt,
        dataAgeHours,
        dataStale: dataAgeHours !== null && dataAgeHours > dataStaleHours,
        // Never having run at all counts as stale — that is the state a feed is
        // in when it was wired up but never scheduled, which is worth shouting
        // about rather than rendering as a blank.
        stale: minutesSince === null || minutesSince > staleAfterMinutes,
      };
    });

    const stale = rows.filter((r) => r.stale);
    this.lastFreshness = {
      checkedAt: new Date(now).toISOString(),
      stale: stale.map((r) => r.job),
    };

    return {
      checkedAt: new Date(now).toISOString(),
      staleCount: stale.length,
      syncEnabled: this.config.get<boolean>('SYNC_ENABLED') ?? false,
      feeds: rows,
    };
  }

  /**
   * The last freshness verdict, for /health. Deliberately a cached value and not
   * a fresh check: a health endpoint gets polled, and this one would otherwise
   * put an aggregate over erp_raw.sync_run behind every probe.
   */
  staleFeeds(): { checkedAt: string; stale: string[] } | null {
    return this.lastFreshness;
  }

  /**
   * Say so, loudly, when a feed has stopped.
   *
   * Every quarter hour, matching the cadence of the feeds it watches. It ran
   * hourly when the feeds did; once they moved to 15 minutes that left /health
   * reporting `degraded` for up to an hour after the cause had cleared — which
   * is how a health endpoint stops being believed. The check is one aggregate
   * over erp_raw.sync_run, so running it four times as often costs nothing.
   *
   * On its own cron, so it keeps reporting while the problem lasts
   * instead of once at the moment it started. It only reads and logs — the cure
   * for a stalled feed is never "quietly sweep it", because the reason is
   * usually something a person needs to see (the service paused, the ERP
   * refusing a key, the database out of disk).
   */
  @Cron('0 5,20,35,50 * * * *', { name: 'erp-freshness' })
  async freshnessTick(): Promise<void> {
    let report: Awaited<ReturnType<SyncScheduler['freshness']>>;
    try {
      report = await this.freshness();
    } catch (error) {
      this.logger.warn(
        `freshness check could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    // A feed whose DATA has stood still, however punctually the job runs.
    //
    // This is reported before (and independently of) staleness, because the two
    // failures look nothing alike from here: a stale feed has stopped running
    // and shouts about it, while a frozen feed keeps answering SUCCESS every 15
    // minutes with nothing behind it. On 2026-11-16 this very check printed
    // "all 12 feed(s) current" while ingest:sales_order had held the same
    // watermark for two days and the app showed no new invoices. A quiet night
    // or a weekend will trip this too — hence a warning that names the ERP's
    // own timestamp, and not an error.
    const frozen = report.feeds.filter((f) => f.dataStale);
    for (const feed of frozen) {
      this.logger.warn(
        `freshness: ${feed.job} is RUNNING but its data has not moved in ` +
          `${feed.dataAgeHours}h — newest record it holds is ${feed.newestDataAt} ` +
          `(ERP clock). Either the ERP has been quiet that long, or this feed is ` +
          `reading a window it never finishes; check for a full sweep in progress.`,
      );
    }

    if (report.staleCount === 0) {
      this.logger.log(
        `freshness: all ${report.feeds.length} feed(s) current` +
          (frozen.length ? `, but ${frozen.length} with data older than expected` : ''),
      );
      return;
    }

    const paused = report.syncEnabled ? '' : ' (SYNC_ENABLED=false — the sync is paused)';
    this.logger.error(`freshness: ${report.staleCount} feed(s) STALE${paused}`);
    for (const feed of report.feeds.filter((f) => f.stale)) {
      this.logger.error(
        `  ${feed.job}: ` +
          (feed.minutesSince === null
            ? 'has never completed a run'
            : `last completed ${feed.minutesSince} minute(s) ago`) +
          ` — it runs every ${feed.everyMinutes}m, so anything past ` +
          `${feed.staleAfterMinutes}m means it is not running`,
      );
    }
  }

  /**
   * Sweep ONE object now, or make every object due immediately.
   *
   * Returns as soon as the work is launched — a sweep takes minutes to hours, far
   * longer than an HTTP request should wait.
   */
  triggerIngest(job?: string): { started: boolean; message: string } {
    if (this.ingestInFlight) {
      return { started: false, message: 'a sweep is already running - try again when it finishes' };
    }

    if (!job) {
      // Forget every recorded run, so the next tick (within a minute) treats all
      // eight as due and works through them one per minute.
      this.lastIngestAt.clear();
      return {
        started: true,
        message: 'all objects marked due - they will sweep one per minute, starting within 60s',
      };
    }

    if (!this.ingestJobNames().includes(job)) {
      return {
        started: false,
        message: `unknown job "${job}" - one of: ${this.ingestJobNames().join(', ')}`,
      };
    }

    this.ingestInFlight = true;
    void (async () => {
      try {
        this.logger.log(`manual trigger - ${job}`);
        const ran = await this.runStage(INGEST_LOCK, () => this.sync.runIngestJob(job));
        if (ran) this.lastIngestAt.set(job, Date.now());
      } finally {
        this.ingestInFlight = false;
      }
    })();

    return { started: true, message: `${job} started - watch: pm2 logs erp-sync` };
  }

  /**
   * Re-read a stated window of one object, now.
   *
   * Goes through the same in-flight guard and the same database lock as the
   * cron, because the ERP asked us not to present them with concurrent queries —
   * a backfill is still a few hundred pages against the endpoint they complained
   * about.
   */
  triggerBackfill(
    job: string,
    window: { field: string; from: string; to: string },
  ): { started: boolean; message: string } {
    if (this.ingestInFlight) {
      return { started: false, message: 'a sweep is already running - try again when it finishes' };
    }
    if (!this.ingestJobNames().includes(job)) {
      return {
        started: false,
        message: `unknown job "${job}" - one of: ${this.ingestJobNames().join(', ')}`,
      };
    }
    if (!window.from || !window.to) {
      return { started: false, message: 'from and to are required, e.g. {"from":"2026-04-28","to":"2026-08-04"}' };
    }

    this.ingestInFlight = true;
    void (async () => {
      try {
        this.logger.log(
          `manual backfill - ${job} (${window.field} ${window.from} .. ${window.to})`,
        );
        // Deliberately does NOT touch lastIngestAt: a backfill is not a sweep, so
        // it must not push the object's next scheduled sweep back.
        await this.runStage(INGEST_LOCK, () => this.sync.runBackfillJob(job, window), {
          ignorePause: true,
        });
      } finally {
        this.ingestInFlight = false;
      }
    })();

    return { started: true, message: `${job} backfill started - watch: pm2 logs erp-sync` };
  }


  /** Run the projection stage now (erp_raw -> public). */
  triggerProjection(): { started: boolean; message: string } {
    void this.projectionTick();
    return { started: true, message: 'projection started - watch: pm2 logs erp-sync' };
  }

  /**
   * Objects whose interval has elapsed, most overdue first.
   *
   * ⚠️ There is deliberately NO "only at its own start minute" test here any
   * more, and that removal is the fix for a real fault. Each object used to be
   * eligible at exactly ONE minute in every interval window. A tick is skipped
   * outright while a sweep is in flight, so any sweep that overran by even a
   * minute stole the NEXT object's only slot — and that object then waited a
   * full interval.
   *
   * Seen in the ERP's own gateway log on 2026-11-09:
   * yvijucrm.sales_order_doc.query arriving at 12:52, 13:22, 13:52, 14:22 —
   * every 30 minutes against a 15-minute setting. sales_delivery (start minute
   * 21) and sales_order (start minute 7) sit one minute apart in the window, so
   * they took turns: whichever ran first pushed the other out, every time.
   *
   * The stagger the ERP asked for does not depend on that test. ingestTick
   * dispatches at most ONE sweep per tick and ERP_INGEST_CONCURRENCY is 1, so
   * two objects cannot start together whatever the minute. offsetMinutes now
   * only breaks ties.
   *
   * After a restart nothing has a recorded run, so every object is due at once —
   * deliberately: one goes per minute until all are caught up, then each settles
   * onto its own interval.
   */
  private dueJobs(): string[] {
    const defaultInterval =
      this.config.get<number>('ERP_INGEST_INTERVAL_MINUTES') ?? 60;
    const now = Date.now();

    return this.ingestSchedule
      .map(({ job, configKey, offsetMinutes }) => {
        const intervalMin = this.config.get<number>(configKey) ?? defaultInterval;
        const slot = this.slotStart(now, intervalMin, offsetMinutes);
        const last = this.lastIngestAt.get(job);
        return {
          job,
          offsetMinutes,
          slot,
          // Never run in this process — the restart catch-up.
          neverRun: last === undefined,
          due: last === undefined || last < slot,
        };
      })
      .filter(({ due }) => due)
      // ⚠️ NEWEST SLOT FIRST, which is not the same as "most overdue first" and
      // is deliberately the opposite of it.
      //
      // Most-overdue-first reads as the fair choice and is the wrong one here,
      // because the job sitting exactly ON its slot is the least overdue thing
      // in the list and therefore always lost to anything running late. Seen at
      // 17:22 on 2026-11-09: other_receivable, three minutes past its own slot,
      // took the tick that belonged to sales_order, which was due that very
      // minute — so the job that was ON TIME is the one knocked off its grid.
      //
      // Every object has a distinct slot minute (the offsets differ), so at most
      // one job is at its slot in any given minute. Giving that job the tick
      // keeps it exactly on its interval, and a job that missed a slot still
      // gets served on the minutes where nobody is scheduled — six of every
      // fifteen.
      //
      // A fresh process is the exception: nothing has run, everything is due,
      // and those go first in schedule order so customer leads and builds the
      // Guid->code bridge the document objects read.
      .sort((a, b) => {
        // Catch-up first, and among those strictly in schedule order: on a fresh
        // process every job is due and none has a meaningful slot to compare, so
        // sorting them by slot would scramble the order that puts customer — and
        // the Guid->code bridge it builds — ahead of the document objects.
        if (a.neverRun !== b.neverRun) return Number(b.neverRun) - Number(a.neverRun);
        if (a.neverRun) return a.offsetMinutes - b.offsetMinutes;
        return b.slot - a.slot || a.offsetMinutes - b.offsetMinutes;
      })
      .map(({ job }) => job);
  }

  /**
   * The most recent point on a job's fixed clock grid, at or before `now`.
   *
   * ⚠️ The grid is why the cadence holds. Due time used to be measured from the
   * PREVIOUS START — `last + interval` — so a run delayed by contention became
   * the base for the next one and the lateness compounded. Measured on
   * 2026-11-09 after the first fix, sales_order went 15:49, 16:04, 16:23, 16:43,
   * 17:03: fifteen minutes, then nineteen, then twenty, then twenty, drifting
   * further out every cycle on a 15-minute setting.
   *
   * Anchored to the clock instead, a job's targets are fixed — :07, :22, :37,
   * :52 for a 15-minute interval at offset 7 — and a late run does NOT move the
   * next one. A run that slips to :10 is followed by :22, which pulls the
   * spacing straight back. The long-run rate is then exactly the configured
   * interval, which is what "every 15 minutes" has to mean.
   *
   * Anchored to the epoch rather than the top of the hour so an interval that
   * does not divide 60 still gets an even grid instead of a short slot each
   * hour.
   */
  private slotStart(now: number, intervalMin: number, offsetMinutes: number): number {
    const intervalMs = Math.max(1, intervalMin) * 60_000;
    const offsetMs = (offsetMinutes % Math.max(1, intervalMin)) * 60_000;
    return Math.floor((now - offsetMs) / intervalMs) * intervalMs + offsetMs;
  }

  // PROJECT: erp_raw → public.*. Runs on its own, more frequent schedule (every
  // 3 min by default) so the backlog drains independently of the slow sweep — a
  // dying ingest no longer starves projection.
  @Cron(process.env.ERP_PROJECT_CRON || '0 */3 * * * *', { name: 'erp-project' })
  async projectionTick(): Promise<void> {
    await this.runStage(PROJECT_LOCK, () => this.sync.runProjection());
  }

  /**
   * Run a stage under its own lease lock, with per-stage timing and failure
   * naming. Ingest and projection each get an independent lock, so one can run
   * while the other is mid-flight.
   */
  /** Returns false when the stage did NOT run (disabled, or the lock was held). */
  private async runStage(
    lockName: string,
    work: () => Promise<void>,
    opts: { ignorePause?: boolean } = {},
  ): Promise<boolean> {
    const tag = `${lockName} #${++this.tickCount}`;
    const startedAt = Date.now();

    // SYNC_ENABLED stops SCHEDULED work. A backfill is an operator typing an
    // explicit, bounded window into an endpoint — a decision the pause switch is
    // not there to override — so it runs, and says plainly that it did.
    if (!this.config.get<boolean>('SYNC_ENABLED') && !opts.ignorePause) {
      this.logger.log(`${tag}: SYNC_ENABLED=false — not running`);
      return false;
    }
    if (!this.config.get<boolean>('SYNC_ENABLED')) {
      this.logger.warn(
        `${tag}: SYNC_ENABLED=false, but this is a manual backfill — running it anyway`,
      );
    }

    const leaseMinutes = this.config.get<number>('SYNC_LOCK_MINUTES') ?? 30;

    let acquired: boolean;
    try {
      acquired = await this.acquire(lockName, leaseMinutes);
    } catch (error) {
      this.logFailure(tag, 'ACQUIRE_LOCK', error, startedAt);
      return false;
    }

    if (!acquired) {
      this.logger.log(
        `${tag}: another worker holds the ${lockName} lock — standing down (${Date.now() - startedAt}ms)`,
      );
      return false;
    }

    let stageError: unknown;
    const workStartedAt = Date.now();
    try {
      await work();
      this.logger.log(`${tag}: completed in ${Date.now() - workStartedAt}ms`);
    } catch (error) {
      stageError = error;
      this.logFailure(tag, 'RUN', error, workStartedAt);
    }

    // A failed release is a real failure: the lease stays held until it expires,
    // so every tick until then stands down. Reporting the stage as "ok" hid that.
    let releaseError: unknown;
    try {
      await this.release(lockName);
    } catch (error) {
      releaseError = error;
      this.logFailure(tag, 'RELEASE_LOCK', error, startedAt);
    }

    const failed = stageError || releaseError;
    this.logger.log(
      `${tag}: ${failed ? 'FAILED' : 'ok'}${releaseError ? ' (lock not released — it will expire)' : ''}` +
        ` — total ${Date.now() - startedAt}ms`,
    );

    return true;
  }

  /**
   * Take the named lease if it is free or expired. Returns false if another
   * worker holds it, in which case this tick stands down.
   */
  private async acquire(lockName: string, leaseMinutes: number): Promise<boolean> {
    const rows = await this.prisma.withRetry(
      () => this.prisma.$queryRaw<{ name: string }[]>`
      INSERT INTO erp_raw.sync_lock (name, locked_until, locked_by, acquired_at)
      VALUES (
        ${lockName},
        (now() + (${leaseMinutes}::int * interval '1 minute')),
        ${this.owner},
        now()
      )
      ON CONFLICT (name) DO UPDATE SET
        locked_until = (now() + (${leaseMinutes}::int * interval '1 minute')),
        locked_by    = ${this.owner},
        acquired_at  = now()
        WHERE erp_raw.sync_lock.locked_until < now()
        RETURNING name
      `,
      `acquire(${lockName})`,
    );
    return rows.length > 0;
  }

  private async release(lockName: string): Promise<void> {
    await this.prisma.withRetry(
      () => this.prisma.$executeRaw`
        UPDATE erp_raw.sync_lock SET locked_until = now()
        WHERE name = ${lockName} AND locked_by = ${this.owner}
      `,
      `release(${lockName})`,
    );
  }

  /**
   * One place that knows how to describe a failure comprehensively: which stage,
   * how long it ran, the Prisma error code/meta when present, and the stack.
   */
  private logFailure(
    tag: string,
    stage: string,
    error: unknown,
    stageStartedAt: number,
  ): void {
    const ms = Date.now() - stageStartedAt;
    const parts: string[] = [`${tag}: STAGE ${stage} FAILED after ${ms}ms`];

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // e.g. code P2010 (raw query failed) — the DB error code is inside meta.
      parts.push(`prisma code=${error.code}`);
      if (error.meta) parts.push(`meta=${JSON.stringify(error.meta)}`);
      parts.push(error.message.replace(/\s+/g, ' ').trim());
    } else if (error instanceof Prisma.PrismaClientInitializationError) {
      parts.push(`prisma init (errorCode=${error.errorCode ?? 'n/a'}): ${error.message}`);
    } else if (error instanceof Error) {
      parts.push(`${error.name}: ${error.message}`);
    } else {
      parts.push(String(error));
    }

    // Pass the Error as the second arg so Nest prints the full stack trace.
    this.logger.error(parts.join(' | '), error instanceof Error ? error.stack : undefined);
  }
}
