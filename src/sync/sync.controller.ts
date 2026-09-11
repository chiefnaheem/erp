import { Body, Controller, Get, Post } from '@nestjs/common';
import { SyncScheduler } from './sync.scheduler';

/**
 * Manual triggers, so a run can be forced without waiting for the schedule (and
 * without restarting the worker, which was the only way before).
 *
 * Everything here delegates to SyncScheduler, which holds the in-flight guard and
 * takes the same database lock as the cron. That is deliberate: a manual sweep
 * must never run alongside a scheduled one, because the ERP explicitly asked us
 * to stop presenting them with concurrent queries.
 *
 * These endpoints return immediately — a sweep runs for minutes to hours, so the
 * work is launched and the caller is told where to watch it.
 */
@Controller('sync')
export class SyncController {
  constructor(private readonly scheduler: SyncScheduler) {}

  /** What is scheduled, what is due, and whether a sweep is running. */
  @Get('status')
  status() {
    return this.scheduler.status();
  }

  /**
   * POST /sync/ingest              → mark all objects due (one sweeps per minute)
   * POST /sync/ingest {"job":"…"}  → sweep that one object now
   */
  @Post('ingest')
  ingest(@Body() body?: { job?: string }) {
    return this.scheduler.triggerIngest(body?.job);
  }

  /** POST /sync/projection → push erp_raw into the app tables now. */
  @Post('projection')
  projection() {
    return this.scheduler.triggerProjection();
  }
}
