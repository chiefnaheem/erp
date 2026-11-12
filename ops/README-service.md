# Keeping erp-sync running

## What is set up now (no admin rights needed)

- **pm2** runs the worker from the built `dist/main.js` (never `nest start --watch`).
  `ecosystem.config.js` holds the tuning: auto-restart, restart backoff, 700 MB
  memory recycling.
- **`pm2 save`** has recorded the process list, so `pm2 resurrect` brings it back.
- **Startup folder launcher** — `erp-sync-resurrect.cmd` (a copy of
  `ops/start-erp-sync.cmd`) waits 30s for the network, then runs `pm2 resurrect`.
  It writes to `logs/resurrect.log`.
- **pm2-logrotate** — rotates at 50 MB, keeps 7 compressed files, daily.

### The limitation

The Startup folder fires **at user logon**, not at boot. If the machine reboots
and nobody logs in as `ServerPC`, the worker stays down. Two ways to close that:

1. Enable auto-logon for the `ServerPC` account, or
2. Install pm2 as a real Windows service — needs administrator rights (below).

This account is not in the Administrators group, so neither a Windows service nor
a `schtasks /sc onstart` task could be created from here (`Access is denied`).

## Installing pm2 as a Windows service (requires an administrator)

Run in an **elevated** PowerShell:

```powershell
# 1. Get pm2-installer
cd C:\Users\ServerPC\Downloads
git clone https://github.com/jessety/pm2-installer.git
cd pm2-installer

# 2. Configure npm + install pm2 as a service running under LocalSystem
npm run configure
npm run configure-policy
npm run setup

# 3. Re-save the process list so the service resurrects it at boot
cd C:\Users\ServerPC\Documents\erp
pm2 start ecosystem.config.js
pm2 save
```

Afterwards remove the Startup-folder launcher, or it will try to resurrect a
second time at logon:

```powershell
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\erp-sync-resurrect.cmd"
```

## Everyday commands

```powershell
pm2 status                     # what is running
pm2 logs erp-sync              # tail logs
pm2 restart erp-sync           # after: npm run build
pm2 describe erp-sync          # restart count, uptime, memory
curl http://localhost:3100/health
```

After any code change: `npm run build` then `pm2 restart erp-sync`.
Never start the production worker with `npm run start:dev` — that is watch mode,
and every file save kills the in-flight ERP sweep.

## Keeping it up: the repeating watchdog (added 2026-11-06)

`pm2` restarts the **app** when it crashes. Nothing restarted **pm2**, and that
gap cost eleven days of sync:

1. 26 Oct — the pm2 daemon stopped. Its saved process list survived, but nothing
   replays that list except `pm2 resurrect`, and the only thing calling it was
   the Startup-folder launcher, which runs **at logon only**. The machine stayed
   logged in, so it never ran. The worker was simply absent.
2. Someone started the worker by hand, outside pm2 — so no autorestart.
3. 5 Nov — the database became unreachable for ten minutes. `DbWatchdog` did
   exactly what it is designed to do and exited the process so a supervisor
   could hand it a fresh client. There was no supervisor. It stayed down.

Nobody noticed until invoices stopped arriving.

`ops/ensure-up.js` closes it. Run on a REPEATING schedule, it checks in order:
app online in pm2 → listed but stopped → absent (daemon restarted: `resurrect`,
then `start` if that did not bring it back) → online but `/health` silent for
three consecutive probes (a wedged process still reads as "online" to pm2).

Every branch is idempotent, so when all is well it costs one pm2 call and one
HTTP GET. If pm2 itself cannot be queried it does **nothing** and says so —
never start a second worker on a guess, because two sweeps of one object delete
each other's rows (see the note in `ops/run-job.js`).

Register it once, from a normal (non-admin) prompt:

```
schtasks /create /tn "erp-sync-watchdog" ^
  /tr "\"C:\Users\ServerPC\Documents\erp\ops\ensure-erp-sync.cmd\"" ^
  /sc minute /mo 5 /f
```

That runs every five minutes while this user is logged on — which is how this
box is actually used. To survive a logout as well, recreate it from an
ADMINISTRATOR prompt with `/ru SYSTEM` added. Check it with:

```
schtasks /query /tn "erp-sync-watchdog" /v /fo list | findstr /i "Status Last Next"
type logs\ensure-up.log
```

The log stays quiet while the worker is healthy; every line in it is the
watchdog having had to do something.

## Is the sync healthy? (start here)

One URL answers it. Anything other than `"status":"ok"` with an empty
`staleFeeds` needs a look:

```
curl http://localhost:3100/health
curl http://localhost:3100/sync/freshness     # per-feed: when each last COMPLETED
```

`freshness` reads `erp_raw.sync_run`, so it survives a restart and tells the
truth about a feed that has stopped. A job failing every cycle shows up here as
stale, because a failed run never completes.

**When something looks wrong, read the job's own status — not a sample row.**
A projection was failing 477 times in a row on 2026-11-09 while the data it had
written the day before still looked fine; checking a row said "working", and
`sync_run` said FAILED the whole time:

```sql
SELECT job, status, started_at, rows_fetched, rows_projected, error
FROM erp_raw.sync_run
WHERE started_at > now() - interval '1 hour'
ORDER BY started_at DESC;
```

Then the logs, in order of usefulness:

```
pm2 logs erp-sync --lines 200          # live
type logs\erp-sync.err.log             # failures only
type logs\ensure-up.log                # the watchdog; SILENT means healthy
```

### The sync stopped overnight

Check whether the machine was even awake before suspecting the code:

```powershell
(Get-CimInstance Win32_OperatingSystem).LastBootUpTime
Get-ScheduledTaskInfo -TaskName 'erp-sync-watchdog' | Select LastRunTime, LastTaskResult
```

On 2026-11-12 the answer was a 01:34 Windows Update reboot and a watchdog task
that only ran at logon — see ops/install-watchdog-task.ps1, which fixes exactly
that.

## After the S4U change: `pm2 list` says EPERM

Expected, and worth knowing before it confuses someone at 2am.

The watchdog task now runs without an interactive logon (LogonType S4U), so the
pm2 daemon it starts lives in that session. pm2's control channel is a named
pipe owned by that session, so running `pm2 list`, `pm2 logs` or
`pm2 restart` from an ordinary prompt gets:

```
Error: connect EPERM \.\pipe\rpc.sock
```

The worker is fine — only the CLI cannot reach it. Use these instead, all of
which work from any session:

| instead of | use |
|---|---|
| `pm2 list` | `curl http://localhost:3100/health` |
| checking the feeds | `curl http://localhost:3100/sync/freshness` |
| `pm2 logs erp-sync` | `type logs\erp-sync.out.log` / `logs\erp-sync.err.log` |
| `pm2 restart erp-sync` | `Start-ScheduledTask -TaskName 'erp-sync-watchdog'` after `pm2 kill`, or reboot |

To get the CLI back temporarily, stop the task and start pm2 yourself:

```
Stop-ScheduledTask -TaskName 'erp-sync-watchdog'
pm2 kill
pm2 start ecosystem.config.js
pm2 save
```

…but remember that a daemon started interactively dies with the session and
will NOT come back after a reboot until someone logs in — which is the whole
problem the S4U task exists to solve. Re-enable the task afterwards with
`Start-ScheduledTask`.

**A second worker cannot sweep concurrently even if two daemons end up running.**
The ingest lease in `erp_raw.sync_lock` is held in the database, not in the
process, so the second one stands down. The worst case is a duplicate crash-
looping on EADDRINUSE against port 3100, which is noisy rather than harmful.
