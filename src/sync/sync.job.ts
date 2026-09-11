import { Injectable, Logger } from '@nestjs/common';
import { RawRepository } from '../raw/raw.repository';

export interface JobStats {
  fetched?: number;
  changed?: number;
  projected?: number;
  skipped?: number;
  /** Extra context for the run log — not persisted as a column. */
  notes?: string[];
}

/**
 * Base for every sync job.
 *
 * Each job is a self-contained class that knows nothing about *how* it is
 * triggered — cron today, BullMQ later. Swapping the scheduler is then a wiring
 * change in SyncService rather than a rewrite of the jobs themselves.
 *
 * run() owns the sync_run bookkeeping so no job can forget to record itself:
 * a crash still closes out the run row as FAILED with the error attached.
 */
// @Injectable() on the abstract base is REQUIRED, not decorative. Subclasses that
// don't declare their own constructor inherit this one, and Nest can only read
// the constructor's design:paramtypes metadata if the class that declares it is
// decorated. Without it Nest silently constructs the subclass with NO arguments,
// leaving `raw` undefined — the job then throws on first use, before it can even
// record itself in sync_run, and fails invisibly.
@Injectable()
export abstract class SyncJob {
  abstract readonly name: string;
  protected readonly logger = new Logger(this.constructor.name);

  /**
   * Fail the run when it fetched work and projected none of it.
   *
   * erp_raw.sync_run is the only window anyone has into this service, and it was
   * lying: the customer projection recorded SUCCESS with rows_projected = 0 on
   * every single cycle for months while 1,847 distributors sat unprojected.
   * Nothing alerted, because nothing was looking at the one number that mattered.
   *
   * OFF for ingest jobs, where rows_projected is legitimately always 0 (they
   * write erp_raw, not public.*). ON for the projections — see the override.
   */
  protected readonly alertOnZeroProjection: boolean = false;

  constructor(protected readonly raw: RawRepository) {}

  protected abstract execute(): Promise<JobStats>;

  async run(): Promise<JobStats> {
    const runId = await this.raw.startRun(this.name);
    const startedAt = Date.now();
    // Set once the run row has been closed out, so the catch below cannot
    // overwrite an already-recorded failure — and with it the row counts that
    // explain WHY it failed — with a second, statless one.
    let recorded = false;

    try {
      const stats = await this.execute();
      const fetched = stats.fetched ?? 0;
      const projected = stats.projected ?? 0;
      const skipped = stats.skipped ?? 0;

      // Rows that were fetched and NOT deliberately stood down. Comparing
      // against `fetched` alone would cry wolf on a batch that was entirely
      // quarantined or entirely waiting on a customer to onboard — both of which
      // are correct outcomes, not faults.
      const eligible = fetched - skipped;
      const starved = this.alertOnZeroProjection && eligible > 0 && projected === 0;

      const summary =
        `${this.name} in ${Date.now() - startedAt}ms — ` +
        `fetched=${fetched} changed=${stats.changed ?? 0} ` +
        `projected=${projected} skipped=${skipped}`;

      if (starved) {
        const error =
          `fetched ${fetched} row(s), ${eligible} of them projectable, but wrote 0 ` +
          `into the app's tables — the projection is not doing its job`;
        await this.raw.finishRun(runId, { status: 'FAILED', ...stats, error });
        recorded = true;
        // ALERT: this is the check that would have surfaced the stalled
        // projector months ago. It must be loud.
        this.logger.error(`${this.name} PROJECTED NOTHING — ${error}`);
        throw new Error(`${this.name}: ${error}`);
      }

      await this.raw.finishRun(runId, { status: 'SUCCESS', ...stats });
      recorded = true;
      this.logger.log(`${summary} ok`);
      for (const note of stats.notes ?? []) this.logger.log(`  ${this.name}: ${note}`);
      return stats;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!recorded) {
        await this.raw.finishRun(runId, { status: 'FAILED', error: message });
        this.logger.error(`${this.name} FAILED: ${message}`);
      }
      throw error;
    }
  }
}
