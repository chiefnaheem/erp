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
// ⚠️ It refuses to start while the scheduled worker holds the ingest lease, and
// that guard is not optional politeness. Two sweeps of the SAME object running
// at once corrupt reconciliation: each tags the keys it has seen with its own
// sweep id and clears any other sweep's tags for that object first (the cleanup
// that removes what a killed sweep left behind). So the one that finishes second
// reconciles against a half-built key set and DELETES rows that are perfectly
// present in the ERP. Seen for real on 2026-09-22: a manual customer sweep run
// beside the scheduled one took raw_customer from 3,827 rows to 3,527. The rows
// come back on the next clean sweep, but nothing should be deleting them.
require('../dist/config/load-env');

const { NestFactory } = require('@nestjs/core');
const { Logger } = require('@nestjs/common');
const { AppModule } = require('../dist/app.module');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { SyncService } = require('../dist/sync/sync.service');

const OWNER = `ops/run-job:${process.pid}`;
const LEASE_MINUTES = 60;

/**
 * TAKE the scheduler's ingest lease, or report who holds it.
 *
 * Taking it, not merely checking it: a check leaves a window in which the
 * scheduler starts its own sweep a second later, which is the same collision
 * from the other direction. This is the identical row the scheduler contends
 * for, so whoever gets it first wins and the other stands down.
 */
const acquireIngestLease = async (prisma) => {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO erp_raw.sync_lock (name, locked_until, locked_by, acquired_at)
     VALUES ('ingest', now() + interval '${LEASE_MINUTES} minutes', $1, now())
     ON CONFLICT (name) DO UPDATE
       SET locked_until = EXCLUDED.locked_until,
           locked_by    = EXCLUDED.locked_by,
           acquired_at  = now()
       WHERE erp_raw.sync_lock.locked_until <= now()
     RETURNING locked_by`,
    OWNER,
  );
  if (rows.length) return { acquired: true };
  const [held] = await prisma.$queryRawUnsafe(
    `SELECT locked_by, locked_until FROM erp_raw.sync_lock WHERE name = 'ingest'`,
  );
  return { acquired: false, held };
};

/** Give it back immediately, rather than leaving it to expire. */
const releaseIngestLease = async (prisma) => {
  await prisma.$executeRawUnsafe(
    `UPDATE erp_raw.sync_lock SET locked_until = now()
     WHERE name = 'ingest' AND locked_by = $1`,
    OWNER,
  );
};

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
  let leaseHeld = null;
  try {
    const prisma = app.get(PrismaService);
    const lease = await acquireIngestLease(prisma);
    if (!lease.acquired) {
      logger.error(
        `the scheduled worker is mid-sweep (lease held by ${lease.held?.locked_by} until ` +
          `${new Date(lease.held?.locked_until).toISOString()}) — refusing to run a second ` +
          `sweep beside it. Wait for it to finish, or stop the worker first.`,
      );
      process.exitCode = 3;
      return;
    }
    leaseHeld = prisma;
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
    // Hand the lease back so the scheduler's next tick is not stood down
    // for an hour waiting for it to expire.
    if (leaseHeld) await releaseIngestLease(leaseHeld);
    await app.close();
  }
})().catch((error) => {
  console.error('FAILED:', error && error.message ? error.message : error);
  process.exit(1);
});
