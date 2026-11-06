// Keep the erp-sync worker running, whatever died.
//
// pm2 restarts the APP when it crashes. Nothing restarted pm2 itself, and that
// is the hole this closes. On 2026-10-26 the pm2 daemon stopped; the saved
// process list survived but nothing replayed it, so the worker was simply
// absent. Someone later started it by hand, outside pm2, and when the database
// went unreachable on 2026-11-05 the watchdog did its job and exited the
// process — with no supervisor to bring it back. The sync was down for eleven
// days and the first anyone knew was that invoices had stopped arriving.
//
// The Startup-folder launcher only runs at logon, which on a server that stays
// logged in for weeks is approximately never. This is meant to run on a REPEATING
// schedule (see ops/README-service.md), and it is deliberately dumb:
//
//   1. is the app online in pm2?            -> nothing to do
//   2. is it listed but stopped/errored?    -> pm2 restart
//   3. is it absent (daemon was restarted)? -> pm2 resurrect, then start if the
//                                              saved list did not bring it back
//   4. online but /health not answering?    -> pm2 restart (a wedged process
//                                              still counts as "online" to pm2)
//
// Every path is idempotent, so running it every few minutes costs one pm2 call
// and one HTTP GET when all is well.
const { execFileSync } = require('node:child_process');
const { appendFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');

const APP = 'erp-sync';
const ROOT = join(__dirname, '..');
const LOG = join(ROOT, 'logs', 'ensure-up.log');
// pm2's JS entry, run under node. NOT pm2.cmd: since Node 20.12 / 24, spawning
// a .cmd without a shell fails outright with EINVAL (the fix for CVE-2024-27980),
// and reaching for shell:true to get around that would put this script's
// arguments through cmd.exe parsing for no benefit.
const PM2_JS =
  process.env.PM2_BIN ||
  join(process.env.APPDATA || '', 'npm', 'node_modules', 'pm2', 'bin', 'pm2');
const PORT = Number(process.env.SYNC_PORT || 3100);
/** A wedged process is only restarted after this many consecutive bad probes. */
const UNHEALTHY_STRIKES = Number(process.env.ENSURE_UP_STRIKES || 3);

const say = (line) => {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  try {
    mkdirSync(join(ROOT, 'logs'), { recursive: true });
    appendFileSync(LOG, `[${stamp}] ${line}\n`);
  } catch {
    /* logging must never be the reason the watchdog fails */
  }
  console.log(line);
};

const pm2 = (...args) =>
  execFileSync(process.execPath, [PM2_JS, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });

/**
 * The app's pm2 status: its state, 'absent' when pm2 runs but has no record of
 * it, or 'unknown' when pm2 could not be asked at all.
 *
 * ⚠️ Those last two must stay distinct. An earlier draft collapsed them, so a
 * failed pm2 call read as "the app is gone" and the watchdog started a SECOND
 * worker — and two workers sweeping one object delete each other's rows (see
 * the note in ops/run-job.js). When pm2 cannot be reached, the only safe move
 * is to do nothing and say so.
 */
const status = () => {
  let raw;
  try {
    raw = pm2('jlist');
  } catch (error) {
    say(`could not run pm2: ${error.message.split('\n')[0]} — doing nothing this round`);
    return 'unknown';
  }
  try {
    const app = JSON.parse(raw).find((p) => p.name === APP);
    return app ? app.pm2_env.status : 'absent';
  } catch {
    say('pm2 returned output that is not a process list — doing nothing this round');
    return 'unknown';
  }
};

const healthy = () =>
  new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/health', timeout: 15000 },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(res.statusCode === 200 && body.includes('"service"')));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });

/**
 * Consecutive failed probes, kept on disk so a restart is only triggered by a
 * sustained outage rather than one slow moment — a sweep can block the event
 * loop briefly, and restarting mid-sweep for that would be worse than waiting.
 */
const strikeFile = join(ROOT, 'logs', '.ensure-up-strikes');
const readStrikes = () => {
  try { return Number(require('node:fs').readFileSync(strikeFile, 'utf8')) || 0; }
  catch { return 0; }
};
const writeStrikes = (n) => {
  try { require('node:fs').writeFileSync(strikeFile, String(n)); } catch { /* ignore */ }
};

(async () => {
  const state = status();

  if (state === 'unknown') return; // pm2 itself is unreachable; status() has said so

  if (state === 'absent') {
    // pm2 has no record of the app: the daemon was restarted, or never replayed
    // the saved list. Resurrect first — it restores every saved app, including
    // the logrotate module — and fall back to the ecosystem file.
    say('pm2 does not know the app — resurrecting the saved process list');
    try { pm2('resurrect'); } catch (error) { say(`resurrect failed: ${error.message.split('\n')[0]}`); }
    if (status() === 'absent') {
      say('resurrect did not bring it back — starting from ecosystem.config.js');
      try { pm2('start', join(ROOT, 'ecosystem.config.js')); pm2('save'); }
      catch (error) { say(`start failed: ${error.message.split('\n')[0]}`); process.exitCode = 1; return; }
    }
    writeStrikes(0);
    say('started');
    return;
  }

  if (state !== 'online') {
    say(`pm2 reports status "${state}" — restarting`);
    try { pm2('restart', APP); writeStrikes(0); say('restarted'); }
    catch (error) { say(`restart failed: ${error.message.split('\n')[0]}`); process.exitCode = 1; }
    return;
  }

  // Online as far as pm2 is concerned. Ask the process itself.
  if (await healthy()) {
    if (readStrikes() > 0) say('health recovered');
    writeStrikes(0);
    return;
  }

  const strikes = readStrikes() + 1;
  writeStrikes(strikes);
  if (strikes < UNHEALTHY_STRIKES) {
    say(`health check failed (${strikes}/${UNHEALTHY_STRIKES}) — waiting before acting`);
    return;
  }

  say(`health check failed ${strikes} times in a row — restarting a wedged worker`);
  try { pm2('restart', APP); writeStrikes(0); }
  catch (error) { say(`restart failed: ${error.message.split('\n')[0]}`); process.exitCode = 1; }
})();
