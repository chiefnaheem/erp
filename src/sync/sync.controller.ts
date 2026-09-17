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
   * GET /sync/freshness → when each feed last completed, and which have stopped.
   *
   * This is the one to check when a number on a screen looks wrong. `status`
   * answers "what is scheduled"; this answers "what has actually happened",
   * from erp_raw.sync_run rather than from memory — so it stays true across a
   * restart, and a paused or failing feed shows up as `stale` instead of as a
   * blank that reads like a fresh start.
   */
  @Get('freshness')
  freshness() {
    return this.scheduler.freshness();
  }

  /**
   * POST /sync/ingest              → mark all objects due (one sweeps per minute)
   * POST /sync/ingest {"job":"…"}  → sweep that one object now
   */
  @Post('ingest')
  ingest(@Body() body?: { job?: string }) {
    return this.scheduler.triggerIngest(body?.job);
  }

  /**
   * POST /sync/backfill {"job":"ingest:sales_delivery","from":"2026-04-28","to":"2026-08-04"}
   *
   * Re-reads that window of that object NOW and upserts it through the ordinary
   * key. Use it when the ERP has WIDENED an object and the rows already stored
   * still carry the old, narrower shape — the scheduled sweep fixes those too,
   * but it walks the feed oldest-first over days and reaches this year last.
   *
   * `field` defaults to DOC_DATE, which is what "records between these dates"
   * means to anyone reading the ERP. Pass LastModifiedDate instead to re-read by
   * when a record was last touched.
   */
  @Post('backfill')
  backfill(@Body() body: { job?: string; from?: string; to?: string; field?: string }) {
    return this.scheduler.triggerBackfill(body?.job ?? '', {
      field: body?.field ?? 'DOC_DATE',
      from: body?.from ?? '',
      to: body?.to ?? '',
    });
  }


  /** POST /sync/projection → push erp_raw into the app tables now. */
  @Post('projection')
  projection() {
    return this.scheduler.triggerProjection();
  }
}
