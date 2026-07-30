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
   * Default is every 15 minutes rather than every minute, because the ERP cannot
   * do deltas — each tick re-reads EVERY order and customer. Content hashing
   * keeps the downstream writes near zero, but the ERP still pays for the read,
   * so the interval is a real cost. Override with ERP_SYNC_CRON.
   *
   * Every stage below is logged and timed independently, and tagged with a tick
   * id (e.g. "tick #7"), so a failure tells you exactly WHICH stage broke —
   * acquiring the lock, running the cycle, or releasing — rather than surfacing a
   * bare Prisma error with no context.
   */
  // INGEST: the heavy ERP → erp_raw sweep. Every 15 min by default.
  @Cron(process.env.ERP_SYNC_CRON || '0 */15 * * * *', { name: 'erp-ingest' })
  async ingestTick(): Promise<void> {
    await this.runStage(INGEST_LOCK, () => this.sync.runIngest());
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
  private async runStage(lockName: string, work: () => Promise<void>): Promise<void> {
    const tag = `${lockName} #${++this.tickCount}`;
    const startedAt = Date.now();

    if (!this.config.get<boolean>('SYNC_ENABLED')) {
      this.logger.log(`${tag}: SYNC_ENABLED=false — not running`);
      return;
    }

    const leaseMinutes = this.config.get<number>('SYNC_LOCK_MINUTES') ?? 30;

    let acquired: boolean;
    try {
      acquired = await this.acquire(lockName, leaseMinutes);
    } catch (error) {
      this.logFailure(tag, 'ACQUIRE_LOCK', error, startedAt);
      return;
    }

    if (!acquired) {
      this.logger.log(
        `${tag}: another worker holds the ${lockName} lock — standing down (${Date.now() - startedAt}ms)`,
      );
      return;
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

    try {
      await this.release(lockName);
    } catch (error) {
      this.logFailure(tag, 'RELEASE_LOCK', error, startedAt);
    }

    this.logger.log(
      `${tag}: ${stageError ? 'FAILED' : 'ok'} — total ${Date.now() - startedAt}ms`,
    );
  }

  /**
   * Take the named lease if it is free or expired. Returns false if another
   * worker holds it, in which case this tick stands down.
   */
  private async acquire(lockName: string, leaseMinutes: number): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
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
    `;
    return rows.length > 0;
  }

  private async release(lockName: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE erp_raw.sync_lock SET locked_until = now()
      WHERE name = ${lockName} AND locked_by = ${this.owner}
    `;
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
