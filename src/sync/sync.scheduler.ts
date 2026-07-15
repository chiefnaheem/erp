import { hostname } from 'node:os';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from './sync.service';

const LOCK_NAME = 'cycle';

@Injectable()
export class SyncScheduler {
  private readonly logger = new Logger(SyncScheduler.name);
  private readonly owner = `${hostname()}:${process.pid}`;
  private tickCount = 0;

  constructor(
    private readonly sync: SyncService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

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
  @Cron(process.env.ERP_SYNC_CRON || '0 */15 * * * *', { name: 'erp-sync-cycle' })
  async tick(): Promise<void> {
    const tag = `tick #${++this.tickCount}`;
    const startedAt = Date.now();

    if (!this.config.get<boolean>('SYNC_ENABLED')) {
      this.logger.log(`${tag}: SYNC_ENABLED=false — not running`);
      return;
    }

    const leaseMinutes = this.config.get<number>('SYNC_LOCK_MINUTES') ?? 30;
    this.logger.log(`${tag}: starting (owner=${this.owner}, lease=${leaseMinutes}m)`);

    // ── Stage 1: acquire the lock ──
    let acquired: boolean;
    try {
      acquired = await this.acquire(leaseMinutes);
    } catch (error) {
      // This is exactly where the make_interval bug surfaced. Name the stage so
      // it can never again look like an anonymous database error.
      this.logFailure(tag, 'ACQUIRE_LOCK', error, startedAt);
      return;
    }

    if (!acquired) {
      this.logger.log(
        `${tag}: another worker holds the sync lock — standing down (${Date.now() - startedAt}ms)`,
      );
      return;
    }
    this.logger.log(`${tag}: lock acquired`);

    // ── Stage 2: run the cycle ──
    let cycleError: unknown;
    const cycleStartedAt = Date.now();
    try {
      await this.sync.runCycle();
      this.logger.log(`${tag}: cycle completed in ${Date.now() - cycleStartedAt}ms`);
    } catch (error) {
      cycleError = error;
      this.logFailure(tag, 'RUN_CYCLE', error, cycleStartedAt);
      // Fall through — the lock MUST be released even when the cycle fails.
    }

    // ── Stage 3: release the lock (always) ──
    try {
      await this.release();
      this.logger.log(`${tag}: lock released`);
    } catch (error) {
      // A failed release is serious: the lease will now be held until it expires,
      // so the next few ticks will stand down. Flag it loudly and distinctly.
      this.logFailure(tag, 'RELEASE_LOCK', error, startedAt);
    }

    const outcome = cycleError ? 'FAILED' : 'ok';
    this.logger.log(`${tag}: ${outcome} — total ${Date.now() - startedAt}ms`);
  }

  /**
   * Take the lease if it is free or expired. Returns false if another worker
   * holds it, in which case this tick simply stands down.
   */
  private async acquire(leaseMinutes: number): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
      INSERT INTO erp_raw.sync_lock (name, locked_until, locked_by, acquired_at)
      VALUES (
        ${LOCK_NAME},
        (now() + (${leaseMinutes}::int * interval '1 minute')),
        ${this.owner},
        now()
      )
      ON CONFLICT (name) DO UPDATE SET
        locked_until = (now() + (${leaseMinutes}::int * interval '1 minute')),
        locked_by    = ${this.owner},
        acquired_at  = now()
      -- Only steal the lock once the previous holder's lease has expired. This is
      -- what makes a worker that died mid-sweep self-healing rather than a
      -- permanent deadlock.
      WHERE erp_raw.sync_lock.locked_until < now()
      RETURNING name
    `;
    return rows.length > 0;
  }

  private async release(): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE erp_raw.sync_lock SET locked_until = now()
      WHERE name = ${LOCK_NAME} AND locked_by = ${this.owner}
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
