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

/**
 * The useful part of a Prisma error, for a one-line log.
 *
 * Prisma prefixes every message with "Invalid `prisma.$queryRaw()` invocation:",
 * so the FIRST line says nothing — the cause is on the last line ("Server has
 * closed the connection.", "Raw query failed. Code: `57P01` …").
 */
function errorDetail(error: unknown): string {
  const meta = (error as { meta?: { code?: string; message?: string } })?.meta;
  if (meta?.code) return `${meta.code} ${meta.message ?? ''}`.trim();

  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? text;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  /** False after any connection-class failure; the next call re-dials. */
  private connected = false;
  private lastOkAt: number | null = null;
  private lastError: string | null = null;

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
        this.connected = true;
        this.lastOkAt = Date.now();
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

  /**
   * Postgres SQLSTATEs that mean "this connection is gone / the server is busy
   * or restarting", not "your query is wrong". Prisma surfaces these inside a
   * P2010 raw-query error, with the real code in `meta.code` — which is why
   * matching only on the Prisma code missed them entirely and turned a routine
   * connection reset into eight failed jobs.
   *
   *   57P01 admin shutdown        — "terminating connection due to administrator command"
   *   57P02 crash shutdown        57P03 cannot connect now (server starting up)
   *   08xxx connection exceptions 53300 too many connections
   *
   * 40P01 / 40001 are not connection faults but they belong here for the same
   * reason: they mean "your transaction lost a race, run it again", and
   * Postgres has already rolled it back for us. The projector takes an advisory
   * lock per job, but two DIFFERENT jobs can still contend — the customer pass
   * writes public."Customer" while the purchase and payment passes hold FK
   * references to it — and a deploy where one instance is still on the previous
   * build has no shared lock at all. Every pass is an idempotent upsert inside
   * one transaction, so replaying it is exactly the right response; without this
   * a lost race failed the whole job and waited for the next tick.
   *
   *   40P01 deadlock_detected     40001 serialization_failure
   */
  private static readonly TRANSIENT_SQLSTATE = new Set([
    '57P01', '57P02', '57P03', '08000', '08003', '08006', '08001', '08004', '53300',
    '40P01', '40001',
  ]);

  /** Prisma-level codes for an unreachable/closed connection or an exhausted pool. */
  private static readonly TRANSIENT_PRISMA = new Set([
    'P1001', 'P1002', 'P1008', 'P1017', 'P2024',
  ]);

  /** True when a failure is worth retrying on a fresh connection. */
  isTransient(error: unknown): boolean {
    const e = error as { code?: string; meta?: { code?: string; message?: string } };
    if (e?.code && PrismaService.TRANSIENT_PRISMA.has(e.code)) return true;
    if (e?.meta?.code && PrismaService.TRANSIENT_SQLSTATE.has(e.meta.code)) return true;

    const message = error instanceof Error ? error.message : String(error);
    // "Engine is not yet connected" is what a client left disconnected by a
    // failed reconnect reports forever. Treating it as transient is what lets
    // the app dig itself out instead of needing a manual restart.
    return /closed the connection|terminating connection|server is shutting down|system is shutting down|reach database server|Timed out fetching|Connection reset|ECONNRESET|EPIPE|connection is closed|Engine is not yet connected|Response from the Engine was empty/i.test(
      message,
    );
  }

  /**
   * Run a DB operation, retrying on a dropped connection with a FRESH pool.
   *
   * The reconnect is the part that matters. When the server terminates its
   * backends every pooled connection is dead at once, so an immediate retry just
   * draws another corpse from the pool and fails with "Server has closed the
   * connection". Disconnecting first forces Prisma to dial again.
   *
   * The backoff also has to outlast a real restart: the old 500ms/1s/2s ladder
   * gave up 3.5s in, while the database was still coming back. This one spans
   * ~60s, which covers the resets seen in production.
   */
  /**
   * Run a DB operation, reconnecting and retrying when the connection drops.
   *
   * ⚠️ The ordering here is the whole point. An earlier version disconnected and
   * reconnected inside a `try {} catch {}` that swallowed the connect failure —
   * so when the database was still down, the client was left DISCONNECTED, and
   * every later query failed instantly with "Engine is not yet connected". That
   * state was permanent: the app stayed up, doing nothing, until restarted by
   * hand. Now the connect happens at the TOP of each attempt, so any later call
   * re-establishes the pool on its own however long the outage lasted.
   */
  async withRetry<T>(op: () => Promise<T>, label: string): Promise<T> {
    const MAX = 6;

    for (let attempt = 1; attempt <= MAX; attempt++) {
      try {
        // If a previous failure left us disconnected, dial again before working.
        if (!this.connected) {
          await this.reconnect();
          this.connected = true;
          this.logger.log(`${label}: database connection re-established`);
        }

        const result = await op();
        this.connected = true;
        this.lastOkAt = Date.now();
        return result;
      } catch (error) {
        const message = errorDetail(error);

        if (!this.isTransient(error)) throw error;

        // Any connection-class failure invalidates the pool. Marking it here is
        // what makes the NEXT attempt (and every future call) reconnect.
        this.connected = false;
        this.lastError = message;

        if (attempt === MAX) {
          this.logger.error(
            `${label}: giving up after ${MAX} attempts — ${message}. ` +
              `The next call will try to reconnect.`,
          );
          throw error;
        }

        const backoff = Math.min(1000 * 2 ** (attempt - 1), 20_000);
        this.logger.warn(
          `${label}: database connection lost (attempt ${attempt}/${MAX}), ` +
            `retrying in ${backoff}ms — ${message}`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    // Unreachable: the loop either returns or throws.
    throw new Error(`${label}: exhausted DB retries`);
  }

  /**
   * Re-establish the connection, at most once at a time.
   *
   * ⚠️ Two hard-won constraints here.
   *
   * 1. NO $disconnect(). The client is shared by every job, and up to 8 ingest
   *    sweeps plus the projections run concurrently. Disconnecting on behalf of
   *    ONE failed statement tears the pool out from under all the others, which
   *    then fail, disconnect, and reconnect in turn — a storm that logs
   *    "connection re-established" and "connection lost" alternately and never
   *    settles. Prisma replaces dead pooled connections by itself; a plain
   *    $connect() (a no-op when already connected) is all that is needed.
   *
   * 2. Single-flight. Without this, every concurrent failure starts its own
   *    reconnect against a database that is already struggling.
   */
  private reconnecting: Promise<void> | null = null;

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return this.reconnecting;

    this.reconnecting = (async () => {
      try {
        await this.$connect();
      } finally {
        this.reconnecting = null;
      }
    })();

    return this.reconnecting;
  }

  /**
   * Liveness for the watchdog and /health: a cheap round-trip that also repairs
   * the connection as a side effect, since it goes through withRetry.
   */
  async ping(): Promise<boolean> {
    try {
      await this.withRetry(() => this.$queryRaw`SELECT 1`, 'ping');
      return true;
    } catch {
      return false;
    }
  }

  /** ms since the last successful DB call, or null if there has never been one. */
  msSinceLastOk(): number | null {
    return this.lastOkAt === null ? null : Date.now() - this.lastOkAt;
  }

  lastFailure(): string | null {
    return this.lastError;
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
