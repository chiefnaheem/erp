import { Logger } from '@nestjs/common';
import { DbWatchdog } from './db-watchdog.service';
import { PrismaService } from './prisma.service';

/**
 * The worker does not crash when the database dies — it idles, failing every
 * tick. A process manager cannot help with that, because nothing ever exits.
 * These pin the behaviour that gives it something to restart.
 */
describe('DbWatchdog', () => {
  let ping: jest.Mock;
  let exit: jest.Mock;
  let prisma: PrismaService;
  let now: number;

  const build = (minutes = 10) => {
    const config = { get: () => minutes } as never;
    return new DbWatchdog(prisma, config, exit as unknown as (code: number) => void);
  };

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    ping = jest.fn();
    exit = jest.fn();
    prisma = { ping, lastFailure: () => 'Server has closed the connection.' } as unknown as PrismaService;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('does nothing while the database answers', async () => {
    ping.mockResolvedValue(true);
    const watchdog = build();
    await watchdog.check();
    await watchdog.check();
    expect(exit).not.toHaveBeenCalled();
  });

  it('tolerates a short outage without restarting', async () => {
    ping.mockResolvedValue(false);
    const watchdog = build(10);
    await watchdog.check(); // outage starts
    now += 5 * 60_000; // 5 minutes in
    await watchdog.check();
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits once the outage passes the limit, so the supervisor restarts us', async () => {
    ping.mockResolvedValue(false);
    const watchdog = build(10);
    await watchdog.check();
    now += 11 * 60_000;
    await watchdog.check();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('clears the timer when the database comes back, so a later blip starts fresh', async () => {
    const watchdog = build(10);
    ping.mockResolvedValue(false);
    await watchdog.check();
    now += 9 * 60_000;

    ping.mockResolvedValue(true); // recovered
    await watchdog.check();

    ping.mockResolvedValue(false); // new, unrelated blip
    await watchdog.check();
    now += 5 * 60_000;
    await watchdog.check();
    expect(exit).not.toHaveBeenCalled();
  });

  it('can be disabled with DB_WATCHDOG_MINUTES=0', async () => {
    ping.mockResolvedValue(false);
    const watchdog = build(0);
    await watchdog.check();
    now += 60 * 60_000;
    await watchdog.check();
    expect(exit).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });
});
