// One-off backfill runner: re-read a stated window of one ERP object, now.
//
//   node ops/backfill.js ingest:sales_delivery 2026-04-08 "2026-04-27 23:59:59" [DOC_DATE]
//
// Does exactly what POST /sync/backfill does, and through the same code — it
// boots the application context and calls SyncService.runBackfillJob — but
// without needing the HTTP listener. That matters on this host: pm2 has more
// than once left an orphaned, elevated node process holding :3100 that cannot
// be killed without an administrator, and a backfill should not be hostage to
// which process won the port.
//
// Like the endpoint, it touches no page cursor, no watermark and no
// reconciliation, so the scheduled sweep carries on from exactly where it
// paused.
//
// ⚠️ It does NOT take the ingest lock. This comment used to claim it did, and
// that is wrong in a way that costs you the sweep: the lock is taken by
// SyncScheduler.runStage around the call, not by runBackfillJob itself, so this
// script reads the ERP in a second process with nothing coordinating it. The
// external-integration licence is concurrency-limited and answers an EMPTY BODY
// when exhausted (CE66044) — indistinguishable from a bad key — so a backfill
// started next to a running sweep makes the SWEEP fail, blind, while this script
// looks fine.
//
// Run it when the worker is paused or idle. For the routine case — re-reading
// the recent window so changes the ERP made without advancing LastModifiedDate
// are picked up — you do not need this script at all: the scheduler now does it
// on idle ticks under the lease (ERP_REFRESH_* in src/config/env.validation.ts).
require('../dist/config/load-env');

const { NestFactory } = require('@nestjs/core');
const { Logger } = require('@nestjs/common');
const { AppModule } = require('../dist/app.module');
const { SyncService } = require('../dist/sync/sync.service');

const [job, from, to, field = 'DOC_DATE'] = process.argv.slice(2);

if (!job || !from || !to) {
  console.error(
    'usage: node ops/backfill.js <job> <from> <to> [field]\n' +
      '   eg: node ops/backfill.js ingest:sales_delivery 2026-04-08 "2026-04-27 23:59:59"',
  );
  process.exit(2);
}

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });
  const logger = new Logger('Backfill');
  try {
    logger.log(`${job}: ${field} ${from} .. ${to}`);
    await app.get(SyncService).runBackfillJob(job, { field, from, to });
    logger.log('done');
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error('FAILED:', error && error.message ? error.message : error);
  process.exit(1);
});
