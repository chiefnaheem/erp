import { Controller, Get, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SyncScheduler } from '../sync/sync.scheduler';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    // @Optional() so a deployment that runs this module without the scheduler
    // still has a health endpoint. It reports on freshness when it can.
    @Optional() private readonly scheduler?: SyncScheduler,
  ) {}

  @Get()
  async check() {
    let database = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }

    // A reachable database and a running process are NOT the same as a working
    // sync. A distributor's credit was two days stale while this endpoint said
    // "ok" — because nothing it reported on had failed; the sweeps had simply
    // stopped. A feed that has stopped is a degraded service, and an external
    // monitor should be able to see that without reading the logs.
    const freshness = this.scheduler?.staleFeeds() ?? null;
    const stale = freshness?.stale ?? [];

    return {
      status: database === 'up' && stale.length === 0 ? 'ok' : 'degraded',
      service: 'erp-sync',
      database,
      syncEnabled: this.config.get<boolean>('SYNC_ENABLED'),
      // null until the first freshness check has run (hourly, at :05).
      staleFeeds: freshness ? stale : null,
      staleCheckedAt: freshness?.checkedAt ?? null,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
