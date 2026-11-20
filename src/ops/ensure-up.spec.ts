/**
 * The watchdog (ops/ensure-up.js) is the only thing keeping the worker alive, so
 * the one mistake it must never make is starting a SECOND one.
 *
 * The sweep survives a duplicate — the ingest lease is held in the database
 * (erp_raw.sync_lock), so the second worker stands down. What does not survive is
 * the supervision: the duplicate either crash-loops on EADDRINUSE, or wins the
 * port and leaves pm2 watching the loser while an orphan on the OLD build serves
 * the traffic. That has happened three times (see ecosystem.config.js), and an
 * orphan is how the eleven-day outage in ops/README-service.md began.
 *
 * The route to a duplicate is narrow and non-obvious: pm2 reaches its daemon over
 * a named pipe owned by one Windows session, so a run of the watchdog from any
 * other session gets an EMPTY process list — and an empty list means "absent",
 * which used to mean "resurrect".
 *
 * Observed on 2026-11-20: the worker was healthy under the scheduled task's own
 * session (pm2 daemon pid 1112, session 0) while `pm2 jlist` from an interactive
 * shell got `EPERM` on the pipe, spawned a daemon of its own and listed nothing.
 *
 * These tests drive the real script as a child process, which is the only honest
 * way to test it — the logic under test lives in a top-level async IIFE and calls
 * pm2 through execFileSync. `PM2_BIN` (already supported, for exactly this) points
 * it at a stub that records its arguments.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AddressInfo } from 'node:net';

const SCRIPT = resolve(__dirname, '..', '..', 'ops', 'ensure-up.js');

describe('ensure-up watchdog', () => {
  let dir: string;
  let stub: string;
  let calls: string;
  let log: string;
  let server: Server | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ensure-up-'));
    stub = join(dir, 'pm2-stub.js');
    calls = join(dir, 'calls.log');
    log = join(dir, 'ensure-up.log');

    // A stand-in for pm2's CLI. `jlist` reports an EMPTY process list — the
    // state a cross-session run produces, and the one that used to trigger a
    // resurrect. Every invocation is appended to a file so the test can assert
    // on what the watchdog actually tried to do.
    writeFileSync(
      stub,
      [
        "const { appendFileSync } = require('node:fs');",
        `appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');`,
        "if (process.argv[2] === 'jlist') console.log('[]');",
        '',
      ].join('\n'),
    );
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((done) => server!.close(() => done()));
      server = undefined;
    }
  });

  /** A worker already answering /health the way the watchdog's probe expects. */
  const serveHealth = async (): Promise<number> => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'erp-sync', database: 'up' }));
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
    return (server!.address() as AddressInfo).port;
  };

  /** A port with nothing on it, so the probe fails the way a dead worker does. */
  const deadPort = async (): Promise<number> => {
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', () => done()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((done) => probe.close(() => done()));
    return port;
  };

  /**
   * Runs the watchdog and resolves with its exit code.
   *
   * Deliberately async: `spawnSync` blocks this process's event loop, so the
   * stub health server above could never answer the child's probe and every run
   * looked like a dead worker. The first version of these tests did exactly
   * that and "passed" the guard by never reaching it.
   */
  const run = (port: number): Promise<number> =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, [SCRIPT], {
        env: {
          ...process.env,
          PM2_BIN: stub,
          SYNC_PORT: String(port),
          ENSURE_UP_LOG: log,
        },
      });
      child.on('error', fail);
      child.on('close', (code) => done(code ?? 0));
    });

  const pm2Calls = () =>
    existsSync(calls)
      ? readFileSync(calls, 'utf8').split('\n').filter(Boolean)
      : [];

  it('starts nothing while the port already serves a healthy worker', async () => {
    const port = await serveHealth();

    await expect(run(port)).resolves.toBe(0);

    // It may ask pm2 what it knows — that is cheap and read-only. It must not
    // act on the answer.
    expect(pm2Calls()).toEqual(['jlist']);
    expect(pm2Calls()).not.toContain('resurrect');
  });

  it('says WHY it stood down, so an unsupervised worker is not invisible', async () => {
    const port = await serveHealth();

    await run(port);

    // Standing down leaves a worker nobody is supervising. That is a real
    // problem — just a smaller one than two workers — so it has to be legible
    // in the log rather than silently tolerated.
    const written = readFileSync(log, 'utf8');
    expect(written).toMatch(/standing down rather than starting a second one/);
    expect(written).toMatch(/erp-sync-watchdog/);
  });

  it('still resurrects when the port is genuinely dead', async () => {
    // The guard must not have cost us the behaviour the watchdog exists for:
    // on 2026-10-26 the pm2 daemon stopped and nothing replayed its saved list,
    // and the sync was down for eleven days.
    const port = await deadPort();

    await expect(run(port)).resolves.toBe(0);

    expect(pm2Calls()).toContain('resurrect');
  });
});
