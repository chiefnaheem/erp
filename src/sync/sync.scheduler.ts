import { hostname } from 'node:os';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from './sync.service';

const LOCK_NAME = 'cycle';

@Injectable()
export class SyncScheduler {
  private readonly logger = new Logger(SyncScheduler.name);
  private readonly owner = `${hostname()}:${process.pid}`;

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
   */
  @Cron(process.env.ERP_SYNC_CRON || '0 */15 * * * *', { name: 'erp-sync-cycle' })
  async tick(): Promise<void> {
    if (!this.config.get<boolean>('SYNC_ENABLED')) return;

    const leaseMinutes = this.config.get<number>('SYNC_LOCK_MINUTES') ?? 30;

    if (!(await this.acquire(leaseMinutes))) {
      this.logger.log('another worker holds the sync lock — skipping this tick');
      return;
    }

    try {
      await this.sync.runCycle();
    } finally {
      // Always release, even if the cycle threw — otherwise the next tick would
      // sit out the whole lease window for no reason.
      await this.release();
    }
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
        now() + make_interval(mins => ${leaseMinutes}),
        ${this.owner},
        now()
      )
      ON CONFLICT (name) DO UPDATE SET
        locked_until = now() + make_interval(mins => ${leaseMinutes}),
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
}
