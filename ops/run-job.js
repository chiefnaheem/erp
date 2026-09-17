// One-off job runner: sweep one ERP object, or run the projection, now.
//
//   node ops/run-job.js ingest:customer_credit
//   node ops/run-job.js projection
//
// The same code the scheduler runs, invoked directly. Two reasons it exists
// beside the HTTP endpoints:
//
//   * pm2 on this host has more than once left an orphaned, elevated node
//     process holding :3100 that cannot be killed without an administrator, so
//     the endpoint can answer from a stale build;
//   * SYNC_ENABLED=false stops scheduled work, and when the sync is paused
//     (today: the database server is out of disk) you still need a way to pull
//     one specific object deliberately.
//
// It takes no lease lock, so do not run it while a scheduled sweep is live —
// check GET /sync/status first, or run it with SYNC_ENABLED=false.
require('../dist/config/load-env');

const { NestFactory } = require('@nestjs/core');
const { Logger } = require('@nestjs/common');
const { AppModule } = require('../dist/app.module');
const { SyncService } = require('../dist/sync/sync.service');

const target = process.argv[2];

if (!target) {
  console.error(
    'usage: node ops/run-job.js <ingest:job|projection>\n' +
      '   eg: node ops/run-job.js ingest:customer_credit',
  );
  process.exit(2);
}

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });
  const logger = new Logger('RunJob');
  try {
    const sync = app.get(SyncService);
    if (target === 'projection') {
      logger.log('running the projection stage');
      await sync.runProjection();
    } else {
      logger.log(`running ${target}`);
      await sync.runIngestJob(target);
    }
    logger.log('done');
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error('FAILED:', error && error.message ? error.message : error);
  process.exit(1);
});
