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
// paused. It takes the ingest lock, so it will not run alongside a sweep.
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
