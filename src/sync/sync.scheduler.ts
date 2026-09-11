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

  constructor(
    private readonly sync: SyncService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * On startup, recover from a previous run of THIS worker that died mid-cycle.
   *
   * A hard kill (Ctrl-C, redeploy, crash) leaves the lease held until it expires
   * — up to SYNC_LOCK_MINUTES — during which every tick stands down. Since a
   * fresh process on this host means the previous process on this host is gone,
   * we release any lock this host holds and close out its dangling RUNNING runs.
   *
   * This is safe for the normal one-worker-per-host deployment. If you ever run
   * multiple replicas on a SINGLE host, drop this (the lease alone is enough).
   */
  async onApplicationBootstrap(): Promise<void> {
    const released = await this.prisma.$executeRaw`
      UPDATE erp_raw.sync_lock SET locked_until = now()
      WHERE name IN (${INGEST_LOCK}, ${PROJECT_LOCK})
        AND locked_by LIKE ${this.host + ':%'}
        AND locked_until > now()
    `;
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
    { job: 'ingest:customer', configKey: 'ERP_INTERVAL_CUSTOMER', offsetMinutes: 0 },
    { job: 'ingest:sales_order', configKey: 'ERP_INTERVAL_SALES_ORDER', offsetMinutes: 7 },
    { job: 'ingest:collection', configKey: 'ERP_INTERVAL_COLLECTION', offsetMinutes: 14 },
    { job: 'ingest:sales_delivery', configKey: 'ERP_INTERVAL_SALES_DELIVERY', offsetMinutes: 21 },
    { job: 'ingest:customer_credit', configKey: 'ERP_INTERVAL_CUSTOMER_CREDIT', offsetMinutes: 28 },
    { job: 'ingest:sales_return', configKey: 'ERP_INTERVAL_SALES_RETURN', offsetMinutes: 35 },
    { job: 'ingest:ar_refund', configKey: 'ERP_INTERVAL_AR_REFUND', offsetMinutes: 42 },
    { job: 'ingest:other_receivable', configKey: 'ERP_INTERVAL_OTHER_RECEIVABLE', offsetMinutes: 49 },
  ];

  /** When each object last STARTED a sweep, so intervals are measured from a run
   *  rather than from the clock. Empty after a restart — see dueJobs(). */
  private readonly lastIngestAt = new Map<string, number>();

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

    const due = this.dueJobs();
    if (due.length === 0) return;

    // ONE per tick. Several may be due at once (notably right after a restart);
    // running them a minute apart is exactly the spreading the ERP asked for.
    const job = due[0];
    this.logger.log(
      `ingest tick — ${job}` +
        (due.length > 1 ? ` (${due.length - 1} more due, one per minute)` : ''),
    );

    // Stamp only if the sweep really ran. A tick that stood down (a longer sweep
    // still holds the lock) must stay due, or a busy object that keeps colliding
    // with a slow one would silently wait a full interval each time it lost.
    this.ingestInFlight = true;
    try {
      const ran = await this.runStage(INGEST_LOCK, () => this.sync.runIngestJob(job));
      if (ran) this.lastIngestAt.set(job, Date.now());
    } finally {
      this.ingestInFlight = false;
    }
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
    };
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

  /** Run the projection stage now (erp_raw -> public). */
  triggerProjection(): { started: boolean; message: string } {
    void this.projectionTick();
    return { started: true, message: 'projection started - watch: pm2 logs erp-sync' };
  }

  /**
   * Objects whose interval has elapsed, in schedule order.
   *
   * After a restart nothing has a recorded run, so every object is due at once —
   * deliberately: one goes per minute until all are caught up, then each settles
   * onto its own interval.
   */
  private dueJobs(): string[] {
    const defaultInterval =
      this.config.get<number>('ERP_INGEST_INTERVAL_MINUTES') ?? 60;
    const now = Date.now();
    const minuteOfHour = new Date(now).getMinutes();

    return this.ingestSchedule
      .filter(({ job, configKey, offsetMinutes }) => {
        const intervalMin = this.config.get<number>(configKey) ?? defaultInterval;
        const last = this.lastIngestAt.get(job);

        // Never run in this process: due now (restart catch-up).
        if (last === undefined) return true;

        // Grace of one tick. `last` records when the sweep STARTED, a second or
        // two after the tick that launched it, so at the next matching minute the
        // elapsed time is always a hair under the interval — 59.97 minutes for a
        // 60-minute interval. Without this the job is judged "not due", waits for
        // the following matching minute, and silently runs at HALF the configured
        // frequency (customer_credit was running every 2 hours, not every 1).
        const TICK_MS = 60_000;
        if (now - last < intervalMin * 60_000 - TICK_MS) return false;

        // Past due AND at its own start minute, so two objects with the same
        // interval still do not fire together. If the offset minute is missed
        // (a long sweep overran it), the next matching minute picks it up.
        return intervalMin >= 60
          ? minuteOfHour === offsetMinutes % 60
          : minuteOfHour % intervalMin === offsetMinutes % intervalMin;
      })
      .map(({ job }) => job);
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
  private async runStage(lockName: string, work: () => Promise<void>): Promise<boolean> {
    const tag = `${lockName} #${++this.tickCount}`;
    const startedAt = Date.now();

    if (!this.config.get<boolean>('SYNC_ENABLED')) {
      this.logger.log(`${tag}: SYNC_ENABLED=false — not running`);
      return false;
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
