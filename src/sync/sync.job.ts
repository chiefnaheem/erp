import { Injectable, Logger } from '@nestjs/common';
import { RawRepository } from '../raw/raw.repository';

export interface JobStats {
  fetched?: number;
  changed?: number;
  projected?: number;
  skipped?: number;
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

  constructor(protected readonly raw: RawRepository) {}

  protected abstract execute(): Promise<JobStats>;

  async run(): Promise<JobStats> {
    const runId = await this.raw.startRun(this.name);
    const startedAt = Date.now();

    try {
      const stats = await this.execute();
      await this.raw.finishRun(runId, { status: 'SUCCESS', ...stats });

      this.logger.log(
        `${this.name} ok in ${Date.now() - startedAt}ms — ` +
          `fetched=${stats.fetched ?? 0} changed=${stats.changed ?? 0} ` +
          `projected=${stats.projected ?? 0} skipped=${stats.skipped ?? 0}`,
      );
      return stats;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.raw.finishRun(runId, { status: 'FAILED', error: message });
      this.logger.error(`${this.name} FAILED: ${message}`);
      throw error;
    }
  }
}
