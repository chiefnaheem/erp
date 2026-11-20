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

**None of the `pm2` subcommands work from an ordinary terminal on this box.** The
worker runs under the watchdog's S4U scheduled task, and pm2's control pipe is
owned by that session, so `pm2 status` / `pm2 logs` / `pm2 restart` answer
`connect EPERM \.\pipe\rpc.sock` — or, worse, quietly start a daemon of their own
and print an EMPTY process list, which reads as "the worker is not running" when
it is running perfectly well. See **`pm2 list` says EPERM** below. Use these:

```powershell
curl http://localhost:3100/health             # what pm2 status would have told you
curl http://localhost:3100/sync/freshness     # per-feed: when each last COMPLETED
type logs\erp-sync.out.log                    # what pm2 logs would have tailed
type logs\erp-sync.err.log                    # failures only
type logs\ensure-up.log                       # the watchdog; SILENT means healthy

# restart (what pm2 restart would have done) — the watchdog does it for you:
echo > logs\.restart-requested
Start-ScheduledTask -TaskName 'erp-sync-watchdog'
```

After any code change: `npm run build`, then the restart pair above.
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
never start a second worker on a guess.

**The port is the authority on whether a worker exists, not pm2** (added
2026-11-20). "Absent" only means *this* pm2 has no record of the app, and because
pm2's control pipe belongs to one session, any run from a different session gets
an empty list and reads it as absent. Resurrecting on that would put a second
worker on a port that is already served, so the watchdog now probes `/health`
first and stands down if anything answers, logging why. The sweep was never the
thing at risk — the ingest lease is in the database — but the duplicate either
crash-loops on `EADDRINUSE` or wins the port and leaves pm2 supervising the
loser while an orphan on the old build serves the traffic. Pinned by
`src/ops/ensure-up.spec.ts`, which drives the real script against a stub pm2.

`start-erp.bat` used to be a second, separate way into that mess: the older
"ERP Service" task still fires it on every boot, and it ran `npm run start:dev`
directly — a watch-mode dev server, outside pm2, on the same port. It now calls
the watchdog instead, so whichever task fires, the outcome is the same one
supervised worker. Retiring that task needs an administrator and is optional:

```powershell
Disable-ScheduledTask -TaskName 'ERP Service'   # elevated; optional
```

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

### "Everything says SUCCESS but the app shows no new records"

The hardest one, because every status light is green. A job can run on time,
report SUCCESS and fetch thousands of rows while storing none of them — so ask
how old the DATA is, not when the job last ran:

```
curl http://localhost:3100/sync/freshness
```

Each ingest feed now carries `newestDataAt` (the newest ERP timestamp it
holds), `dataAgeHours`, and `dataStale`. `staleCount` can be 0 while a feed is
frozen solid; that is precisely the case this field exists for.

A feed reading `dataStale` is not automatically a fault — the ERP may simply
have been quiet, which is the honest answer for `ingest:sales_return` (no
return documents since September 2026). Confirm against the ERP before
treating it as a bug:

```sql
-- what we hold, per feed
SELECT job, cursor_value FROM erp_raw.sync_cursor
WHERE job LIKE 'watermark:ingest:%' OR job LIKE 'catchup:ingest:%' ORDER BY job;
```

On 2026-11-16 `ingest:sales_order` had held `2026-11-14 18:22:35` for two days
while running every 15 minutes. The cause was a full sweep in progress (the
page cursor `ingest:sales_order` sits at `<page>@<size>`): during one, the
sweep watermark is frozen by design and the catch-up lane is the only thing
keeping the feed current. Check that the lane is actually advancing —

```
findstr /C:"catch-up" logs\erp-sync.out.log
```

— and that `now current to` moves between runs. If it does not, the lane is
re-reading a window it never finishes.

### "The ERP record was edited but ours still shows the old values"

First, check whether the edit moved the ERP's own `LastModifiedDate`, because
everything that keeps a feed fresh filters on exactly that field:

```sql
-- what we hold for the document, and when we noticed it change
SELECT payload->>'DOC_NO', payload->>'LastModifiedDate', changed_at, projected_at
FROM erp_raw.raw_sales_order WHERE payload->>'DOC_NO' = '<doc no>';
```

If `changed_at` is recent, we saw it — look at the projection instead (the row
may be queued because the customer has not onboarded; `project_error` says so).

If `LastModifiedDate` is OLD and the ERP values have moved anyway, this is the
**silent-change** case. The ERP does not always advance `LastModifiedDate`: the
clearest example is posting a DELIVERY against a sales order, which updates
`DELIVERED_BUSINESS_QTY` and `CLOSE` in place and leaves `LastModifiedDate`
alone. No incremental or catch-up query can ever see those rows — they filter on
the field that did not move.

Measured on 2026-11-19, over the two days after the catch-up fix: of 2,472
genuine updates to existing sales-order rows, 2,434 landed within ~16 minutes
and **38 were found 10 to 27 days late**, every one of them with
`BUSINESS_QTY = DELIVERED_BUSINESS_QTY`.

Two things cover it, and you can check both:

```
curl http://localhost:3100/sync/status      # the "refresh" block
findstr /C:"refresh tick" logs\erp-sync.out.log
```

1. **The recent-window refresh** (`ERP_REFRESH_*`) re-reads the last
   `ERP_REFRESH_WINDOW_DAYS` (45) of `DOC_DATE` every `ERP_REFRESH_EVERY_MINUTES`
   (360). It filters on `DOC_DATE`, not `LastModifiedDate`, which is the whole
   point. Cheap: measured 2026-11-19, a 2-day window was 867 rows in one page in
   7 seconds, and a 30-day window is ~16 pages against the full sweep's 1,158.

   It normally waits for a tick no sweep wants, and **preempts the sweeps once it
   is two intervals (12h) overdue**. That second rule is not belt-and-braces: the
   first version only ever took idle ticks, and on this box the heavy objects run
   to `ERP_SWEEP_MAX_MINUTES` so something is due on nearly every minute — three
   deploys went by without the lane running once. A lane that can be starved
   indefinitely is the same as no lane.

   To force one now (it takes the ingest lease, so it will not collide with a
   sweep):

   ```
   curl -X POST http://localhost:3100/sync/backfill ^
     -H "Content-Type: application/json" ^
     -d "{\"job\":\"ingest:sales_order\",\"from\":\"2026-11-01\",\"to\":\"2026-11-19 23:59:59\"}"
   ```
2. **The full sweep** (`ERP_FULL_SWEEP_DAYS`, 7) remains the backstop for
   documents older than the window.

To find how late we are detecting changes on any feed:

```sql
SELECT count(*) FILTER (WHERE lag_h < 1)   AS prompt,
       count(*) FILTER (WHERE lag_h > 168) AS only_the_full_sweep_found_it
FROM (SELECT EXTRACT(EPOCH FROM
        (changed_at - (payload->>'LastModifiedDate')::timestamp))/3600 AS lag_h
      FROM erp_raw.raw_sales_order
      WHERE changed_at > now() - interval '2 days'
        AND changed_at > first_seen_at + interval '1 second') z;
```

⚠️ That `changed_at > first_seen_at` filter is not optional. Without it a row
read for the FIRST time — whose document may be two years old — is
indistinguishable from a silent change, and the number comes out ~40x too high.

⚠️ Do not reach for `node ops/backfill.js` to fix one of these by hand while the
worker is running. It does not take the ingest lock, and the ERP's integration
licence is concurrency-limited: a second reader makes the running **sweep** fail
with empty bodies while the backfill itself looks fine.

### One invariant worth checking after any projection change

A raw row stamped `projected_at` while holding content nothing projected is
stranded for good — `projected_at` is no longer NULL, the watermark has moved
past its `changed_at`, and only the ERP touching that record a second time brings
it back. It has a signature that cannot be anything else:

```sql
SELECT 'credit' AS t, count(*) FROM erp_raw.raw_customer_credit
  WHERE projected_at IS NOT NULL AND projected_at < changed_at
UNION ALL SELECT 'collection', count(*) FROM erp_raw.raw_collection
  WHERE projected_at IS NOT NULL AND projected_at < changed_at
UNION ALL SELECT 'sales_order', count(*) FROM erp_raw.raw_sales_order
  WHERE projected_at IS NOT NULL AND projected_at < changed_at;
-- every count must be 0
```

On 2026-11-19 these were 635 / 168 / 17. The cause: a projection run is one
transaction, but READ COMMITTED gives each STATEMENT its own snapshot, and the
consume step was written as `UPDATE ... WHERE <selector>` — so it re-evaluated
the selector at the END of the run and stamped rows the ingest had changed since
the values were read at the start. The 635 credit rows were 31 distributors whose
outstanding balance in the portal was a figure the ERP had already moved on from.

Every consume statement now stamps from a snapshot taken before the values were
read and requires `changed_at` to still match, so a row that moves mid-run stays
queued. If the counts above are ever non-zero again, a consume statement has lost
its guard; re-queue the affected rows with

```sql
UPDATE erp_raw.<table> SET projected_at = NULL
WHERE projected_at IS NOT NULL AND projected_at < changed_at;
```

### Ghost lines: an order whose quantity "never updated"

Editing an order in the ERP replaces its lines, and the removed ones are deleted
from `erp_raw` only when a FULL sweep completes and RECONCILES — see
"Deletions the sweep never applied" below, which is why that had never once
happened on the big objects before 2026-11-19. Until then one `DOC_NO` holds
lines from two versions, and because
`QTY_TOTAL` / `AMT_UNINCLUDE_TAX_OC` / `TAX_OC` are header totals repeated onto
every line, the two versions disagree about the document's totals.

The projection takes the header from the line with the newest
`LastModifiedDate`, so the surviving version wins. It used to take the lowest row
id — the oldest line held — which on 2026-11-19 published 1137 items for
`2301-202611110031`, an order the ERP says is 2379. Worse, eligibility was a
`bool_and` of `ApproveStatus` over every stored line, so one stale `N` ghost
excluded the whole document from the upsert: it kept its old row and was
re-scanned by every run for ever. 15 of the 16 affected documents were in that
state.

To find them:

```sql
SELECT btrim(payload->>'DOC_NO'), count(DISTINCT payload->>'QTY_TOTAL') AS versions
FROM erp_raw.raw_sales_order
WHERE (payload->>'DOC_DATE')::timestamp > now() - interval '120 days'
GROUP BY 1 HAVING count(DISTINCT payload->>'QTY_TOTAL') > 1;
```

### Deletions the sweep never applied (fixed 2026-11-19)

**Symptom.** A document shows more lines than the ERP has — most visibly in the
admin portal's Sales Delivery modal, which reads `erp_raw.raw_sales_delivery`
directly, so three stored lines become three rows on screen and a total that is
too high. `2510-202611160001` showed 3 lines totalling 4,227 cartons and
₦6,072,000 when the ERP had one line: 3,848 @ ₦1,500 = ₦5,772,000.

**Why it is invisible to every other lane.** A deletion is not a modification.
The row simply stops being returned, and no `LastModifiedDate` filter can ask
for "things that are gone". Only a full sweep can notice, by recording every key
it saw and deleting what it did not.

**The bug.** That key set was destroyed twice per turn. A full sweep of a big
object does not fit in one turn — sales_delivery is 1,324 pages over ~15 of them
— and each paused turn called `clearSeen()` while each resumed turn minted a new
`sweepId`, whose `clearStaleSeen()` removed the previous turn's keys. The sweep
that finished on 2026-11-18 therefore ended holding 1,056 keys against 1,324,311
rows; the safety check refused it, as designed:

```
ingest:sales_delivery: SKIPPING reconciliation — the sweep saw 1056 key(s)
but 1324311 row(s) are held. That gap is too large to trust; nothing deleted.
```

Reconciliation had **never run** on sales_delivery, sales_order, collection or
other_receivable. It worked only on customer and customer_credit — the objects
small enough to sweep in one turn, which is exactly why nobody noticed.

**The fix.** The sweep identity lives in `sync_cursor` under `sweep:<job>` and is
reused for as long as the page cursor says a sweep is mid-flight, so the keys
accumulate across turns. Two guards came with it:

- only rows with `first_seen_at` older than the sweep's START are judged, because
  the incremental lane keeps inserting behind a multi-day sweep and those rows
  were never offered to it;
- a reconciliation that would delete more than `ERP_RECONCILE_MAX_DELETE_PCT`
  (default 20%) of what it judged is reported and refused, not applied.

**To check it is working**, during a full sweep:

```sql
SELECT * FROM erp_raw.sync_cursor WHERE job LIKE 'sweep:%';
SELECT object_type, count(*) FROM erp_raw.sweep_seen GROUP BY 1;
```

The count must keep climbing across turns. If it resets to roughly one turn's
worth each time, the identity is not being reused and nothing will be deleted.
Afterwards, look for `removed N stale row(s)` — or a `SKIPPING` line, which now
reports the exact figure it refused.

**The recent window clears them sooner.** A full sweep reads oldest-first, so it
reaches a document edited today LAST — about two days on sales_delivery. The
refresh lane (`ERP_REFRESH_JOBS`, every `ERP_REFRESH_EVERY_MINUTES`) re-reads a
`DOC_DATE` window and now removes deleted lines inside it, so an edited document
is corrected within hours instead.

It deliberately makes a narrower claim than the full sweep. A window only asked
the ERP for part of the feed, so "the ERP did not return this key" proves
nothing on its own — that reasoning, applied to a sweep whose paging had skipped
rows, once deleted 100 live customers. Instead a line is deleted only when
ANOTHER line of the SAME document came back in the same pass. A document the
window missed contributes no lines, so nothing about it can be deleted. Whole
documents deleted in the ERP are therefore still the full sweep's job.

To run one by hand (it respects the ingest lease):

```
curl -s -X POST http://127.0.0.1:3100/sync/backfill -H "Content-Type: application/json" \
  -d '{"job":"ingest:sales_delivery","from":"2026-11-16 00:00:00","to":"2026-11-19 23:59:59"}'
```

Then look for `window reconciliation removed N line(s)`. Set
`ERP_BACKFILL_RECONCILE=false` to turn the deleting half off and leave the
re-read as a pure upsert.

**To force a sweep** rather than wait for the 7-day cadence, backdate its marker
(it is read from `updated_at`, not from the value):

```sql
UPDATE erp_raw.sync_cursor SET updated_at = now() - interval '8 days'
WHERE job = 'watermark:full:ingest:sales_delivery';
```

Deleting that row does NOT force a sweep — `needsFullSweep()` re-stamps a missing
marker and waits another 7 days.

### The sync stopped overnight

Check whether the machine was even awake before suspecting the code:

```powershell
(Get-CimInstance Win32_OperatingSystem).LastBootUpTime
Get-ScheduledTaskInfo -TaskName 'erp-sync-watchdog' | Select LastRunTime, LastTaskResult
```

On 2026-11-12 the answer was a 01:34 Windows Update reboot and a watchdog task
that only ran at logon — see ops/install-watchdog-task.ps1, which fixes exactly
that.

### "The server stopped running" — but it hadn't (2026-11-20)

A report came in that the server had stopped. It had not: the worker had been up
for 28 hours without a single restart, and `pm2` had not relaunched it once.

**Ask this first, before touching anything.** `uptimeSeconds` is the process's
own uptime, so it settles the question in one call:

```powershell
curl http://localhost:3100/health
```

What had actually happened is that the link to the database dropped. From 15:27
to roughly 16:42 every query failed with Prisma `P1001`:

```
Can't reach database server at `<db-host>:6543`
```

The process stayed up and kept retrying, exactly as designed, but it could do no
work — and a worker that is running and doing nothing looks identical, from the
web app, to a worker that has died.

Two things made it confusing, and both are worth knowing:

- **No ERP calls appear in the log for that window either**, which looks like the
  ERP gateway failed too. It did not. Every ingest job takes its database lease
  *before* it calls the ERP, so a database outage means the ERP is never reached.
  Do not go hunting for a gateway fault on this evidence.
- **Recovery was not instant.** The database came back around 16:42, but ingest
  did not resume until 17:27. The projection lane had a backlog and each cycle
  re-scanned ~100k rows, so it held the single lease back to back and starved
  ingest for 45 minutes. It cleared on its own; all feeds were current by 17:35.

To confirm where the fault was rather than guessing:

```sql
-- did the database engine itself restart, or just the connection path?
SELECT pg_postmaster_start_time();
```

On 2026-11-20 that returned 14 Nov — Postgres had never gone down, so the fault
was the network path or the pooler on :6543, not the database. The link flapped
again for about a minute at 20:00 and recovered by itself. Latency to that host
is ~190ms against ~14ms to a neutral public address, so it is a long way off;
intermittent drops there are not something this box can fix, and the worker is
already built to ride them out.

**The other way this report happens with nothing wrong at all:** somebody runs
`pm2 list`, gets an empty table, and concludes the worker is gone. On this box an
empty `pm2 list` means only that the CLI could not reach the right daemon — see
the next section. Seven abandoned daemons from such calls had piled up holding
430 MB; they manage nothing and are safe to kill (keep the one whose children are
the worker and `pm2-logrotate`).

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
| `pm2 restart erp-sync` | see **Restarting / deploying** below |

### Restarting, and deploying a new build

`pm2 restart` answers EPERM from an ordinary shell, and even
`Stop-Process -Id <worker pid>` is "Access is denied" — the worker lives in the
task's own session. So ask the watchdog, which is already in that session:

```
npx nest build                                   # if you changed code
echo > logs\.restart-requested
Start-ScheduledTask -TaskName 'erp-sync-watchdog'
```

The next watchdog run consumes the file and restarts the worker. It is consumed
BEFORE the restart is attempted, so a restart that fails does not loop. Without
the explicit trigger it is picked up by the next scheduled run anyway, within
five minutes.

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
