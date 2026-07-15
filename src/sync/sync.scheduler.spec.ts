import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RawMigrator } from '../raw/raw.migrator';
import { SyncService } from './sync.service';
import { SyncScheduler } from './sync.scheduler';

/**
 * Exercises the lock SQL against the REAL database. This is the test that was
 * missing when make_interval(mins => <bigint>) shipped and failed at runtime with
 * "function make_interval(mins => bigint) does not exist".
 */
describe('SyncScheduler lock (integration)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaService;
  let scheduler: SyncScheduler;
  let cycleRuns = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PrismaService,
        RawMigrator,
        SyncScheduler,
        { provide: SyncService, useValue: { runCycle: async () => void cycleRuns++ } },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) =>
              ({ SYNC_ENABLED: true, SYNC_LOCK_MINUTES: 30 } as Record<string, unknown>)[k],
          },
        },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    await prisma.$connect();
    await moduleRef.get(RawMigrator).apply();
    scheduler = moduleRef.get(SyncScheduler);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM erp_raw.sync_lock WHERE name = 'cycle'`);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    cycleRuns = 0;
    await prisma.$executeRawUnsafe(`DELETE FROM erp_raw.sync_lock WHERE name = 'cycle'`);
  });

  it('acquires the lease and runs a cycle (the make_interval bug would throw here)', async () => {
    // If the lock SQL were still broken this would throw before running the cycle.
    await scheduler.tick();
    expect(cycleRuns).toBe(1);

    // tick() releases the lease in its finally block, so afterwards it is no
    // longer held into the future — proving both acquire AND release ran.
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT locked_until <= now() AS released FROM erp_raw.sync_lock WHERE name = 'cycle'`,
    );
    expect(rows[0]?.released).toBe(true);
  });

  it('a second worker stands down while the lease is held', async () => {
    // Pretend another worker holds a fresh lease.
    await prisma.$executeRawUnsafe(
      `INSERT INTO erp_raw.sync_lock (name, locked_until, locked_by)
       VALUES ('cycle', now() + interval '30 minutes', 'other-worker')`,
    );

    await scheduler.tick();
    expect(cycleRuns).toBe(0); // must NOT run while someone else holds it
  });

  it('steals an EXPIRED lease and runs (self-healing after a dead worker)', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO erp_raw.sync_lock (name, locked_until, locked_by)
       VALUES ('cycle', now() - interval '1 minute', 'dead-worker')`,
    );

    await scheduler.tick();
    expect(cycleRuns).toBe(1); // expired lease → we take over
  });

  it('logs the failing STAGE when the cycle throws, and still releases the lock', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const boom = new Error('kaboom');
    const runCycle = jest
      .spyOn((scheduler as any).sync, 'runCycle')
      .mockRejectedValueOnce(boom);

    await scheduler.tick(); // must NOT throw out of tick

    // The failure is attributed to the RUN_CYCLE stage, not left anonymous.
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/STAGE RUN_CYCLE FAILED/);
    expect(logged).toMatch(/kaboom/);

    // Lock must have been released despite the failure (next tick can proceed).
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT locked_until <= now() AS released FROM erp_raw.sync_lock WHERE name = 'cycle'`,
    );
    expect(rows[0]?.released).toBe(true);

    runCycle.mockRestore();
    errorSpy.mockRestore();
  });
});
