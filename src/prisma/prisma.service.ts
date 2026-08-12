import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Append connection timeouts to the DB URL so the flaky managed Postgres can't
 * hang the worker. Without socket_timeout, a half-open connection (DB accepted
 * the TCP session then stopped responding) leaves a query awaiting FOREVER — the
 * sweep sits RUNNING and pm2 can't help because the process hasn't crashed. With
 * these set, a stuck query errors out and the job's retry/fail path takes over,
 * so the cycle completes and the next one resumes.
 */
function withTimeouts(url: string): string {
  try {
    const u = new URL(url);
    const setDefault = (key: string, value: string) => {
      if (!u.searchParams.has(key)) u.searchParams.set(key, value);
    };
    setDefault('connect_timeout', '15'); // seconds to establish a connection
    setDefault('pool_timeout', '30'); // seconds to wait for a pool slot
    setDefault('socket_timeout', '120'); // seconds a single query may run before it's killed
    setDefault('connection_limit', '5'); // bound the pool — fewer conns = less stress on a loaded DB
    return u.toString();
  } catch {
    return url; // malformed URL — let Prisma surface its own error
  }
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      datasources: { db: { url: withTimeouts(process.env.DATABASE_URL ?? '') } },
    });
  }

  /**
   * Connect with retry+backoff instead of crashing on a transient blip. Prisma
   * connects during onModuleInit, so a single blip at boot would otherwise kill
   * the whole worker — and on a box with no process manager it would stay down.
   */
  async onModuleInit() {
    const MAX = 12;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      try {
        await this.$connect();
        if (attempt > 1) this.logger.log(`database connected on attempt ${attempt}`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
        if (attempt === MAX) {
          this.logger.error(
            `could not reach the database after ${MAX} attempts — giving up. ${message}`,
          );
          throw error;
        }
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 15_000);
        this.logger.warn(
          `database unreachable (attempt ${attempt}/${MAX}), retrying in ${backoff}ms — ${message}`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
