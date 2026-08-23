import { Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * The managed Postgres drops every connection at once (restart, backup, admin
 * terminate). These cover the two things that made that fatal: not recognising
 * the SQLSTATE, and retrying on the same dead pool.
 */
describe('PrismaService.withRetry', () => {
  let prisma: PrismaService;
  let connect: jest.SpyInstance;
  let disconnect: jest.SpyInstance;

  /** Prisma reports a Postgres SQLSTATE inside meta, under a P2010 raw error. */
  const rawQueryError = (sqlstate: string, message: string) =>
    Object.assign(new Error(`Raw query failed. Code: \`${sqlstate}\`. Message: \`${message}\``), {
      code: 'P2010',
      meta: { code: sqlstate, message },
    });

  beforeEach(() => {
    process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';
    prisma = new PrismaService();
    connect = jest.spyOn(prisma, '$connect').mockResolvedValue(undefined);
    disconnect = jest.spyOn(prisma, '$disconnect').mockResolvedValue(undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn(); // run backoffs instantly
      return 0 as unknown as NodeJS.Timeout;
    }) as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('treats 57P01 (admin terminate) as transient — the case that failed all 8 jobs', () => {
    expect(
      prisma.isTransient(
        rawQueryError('57P01', 'FATAL: terminating connection due to administrator command'),
      ),
    ).toBe(true);
  });

  it('recognises the other connection-class failures seen in production', () => {
    expect(prisma.isTransient(rawQueryError('57P03', 'the database system is shutting down'))).toBe(true);
    expect(prisma.isTransient(Object.assign(new Error('x'), { code: 'P1017' }))).toBe(true);
    expect(prisma.isTransient(new Error('Server has closed the connection.'))).toBe(true);
  });

  it('does NOT retry a genuine query error', async () => {
    const op = jest.fn().mockRejectedValue(
      Object.assign(new Error('column "nope" does not exist'), { code: 'P2010', meta: { code: '42703' } }),
    );
    await expect(prisma.withRetry(op, 'bad-sql')).rejects.toThrow(/does not exist/);
    expect(op).toHaveBeenCalledTimes(1); // no wasted retries
  });

  it('reconnects between attempts, then succeeds', async () => {
    await prisma.onModuleInit(); // mirror a booted app: already connected
    connect.mockClear();
    disconnect.mockClear();

    const op = jest
      .fn()
      .mockRejectedValueOnce(rawQueryError('57P01', 'terminating connection due to administrator command'))
      .mockRejectedValueOnce(new Error('Server has closed the connection.'))
      .mockResolvedValue('recovered');

    await expect(prisma.withRetry(op, 'upsert')).resolves.toBe('recovered');
    expect(op).toHaveBeenCalledTimes(3);
    // The dead pool is dropped and re-dialled before each RETRY — otherwise the
    // retry just draws another dead connection and fails identically.
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('gives up after 6 attempts and rethrows the original error', async () => {
    const op = jest.fn().mockRejectedValue(rawQueryError('57P01', 'terminating connection'));
    await expect(prisma.withRetry(op, 'upsert')).rejects.toThrow(/terminating connection/);
    expect(op).toHaveBeenCalledTimes(6);
  });

  it('treats "Engine is not yet connected" as transient — the wedged-client case', () => {
    // A failed reconnect used to leave the client disconnected forever; every
    // later query reported this, and it was classified as permanent.
    expect(
      prisma.isTransient(new Error('Invalid `prisma.$queryRaw()` invocation:\n\nEngine is not yet connected.')),
    ).toBe(true);
  });

  it('recovers on a LATER call after the reconnect itself failed', async () => {
    // Reconnect fails while the database is still down...
    connect.mockRejectedValueOnce(new Error("Can't reach database server"));
    const failing = jest.fn().mockRejectedValue(new Error('Server has closed the connection.'));
    await expect(prisma.withRetry(failing, 'during-outage')).rejects.toThrow();

    // ...and once the database is back, an ordinary call reconnects by itself,
    // with no process restart. This is what was broken.
    connect.mockResolvedValue(undefined);
    const working = jest.fn().mockResolvedValue('ok');
    await expect(prisma.withRetry(working, 'after-outage')).resolves.toBe('ok');
    expect(working).toHaveBeenCalled();
  });

  it('reports how long ago the database last worked', async () => {
    expect(prisma.msSinceLastOk()).toBeNull();
    await prisma.withRetry(async () => 'ok', 'probe');
    expect(prisma.msSinceLastOk()).toBeGreaterThanOrEqual(0);
  });
});
