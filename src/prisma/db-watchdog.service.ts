import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from './prisma.service';

/**
 * Last-resort recovery: exit the process when the database has been unusable for
 * long enough that the in-process retries are clearly not winning.
 *
 * This exists because of a real failure mode: the worker does NOT crash when the
 * database goes away. It stays up, healthy-looking, and fails every tick — so a
 * process manager sees a running process and never restarts it. A supervisor can
 * only help if something eventually exits, and that is this class's whole job.
 *
 * Ordering matters: PrismaService.withRetry now reconnects on its own, so this
 * should almost never fire. It is the backstop for the case where the client is
 * wedged in a way reconnecting cannot fix (a corrupted engine, an OOM-killed
 * query engine binary) and only a fresh process will do.
 *
 * Exiting non-zero is the signal pm2 (or any service wrapper) needs to relaunch
 * us, and its restart backoff stops that becoming a hot loop while the database
 * is genuinely down.
 */
@Injectable()
export class DbWatchdog {
  private readonly logger = new Logger(DbWatchdog.name);
  private failingSince: number | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    /**
     * Injected so tests can assert on it instead of killing the runner.
     * @Optional() is REQUIRED: a default value does NOT stop Nest trying to
     * resolve this parameter, and it cannot resolve a bare function type — the
     * app then fails to boot with UnknownDependenciesException on every start,
     * which pm2 sees as a crash loop.
     */
    @Optional()
    private readonly exit: (code: number) => void = (code) => process.exit(code),
  ) {}

  @Interval(60_000)
  async check(): Promise<void> {
    const limitMinutes = this.config.get<number>('DB_WATCHDOG_MINUTES') ?? 10;
    if (limitMinutes <= 0) return; // disabled

    const ok = await this.prisma.ping();

    if (ok) {
      if (this.failingSince !== null) {
        const downFor = Math.round((Date.now() - this.failingSince) / 1000);
        this.logger.log(`database recovered after ${downFor}s — no restart needed`);
      }
      this.failingSince = null;
      return;
    }

    if (this.failingSince === null) this.failingSince = Date.now();
    const downMs = Date.now() - this.failingSince;
    const limitMs = limitMinutes * 60_000;

    if (downMs < limitMs) {
      this.logger.warn(
        `database unreachable for ${Math.round(downMs / 1000)}s ` +
          `(restarting the process at ${limitMinutes}m) — ${this.prisma.lastFailure() ?? 'no detail'}`,
      );
      return;
    }

    this.logger.error(
      `database unreachable for ${Math.round(downMs / 60_000)}m — exiting so the ` +
        `process manager restarts this worker with a fresh database client.`,
    );
    this.exit(1);
  }
}
