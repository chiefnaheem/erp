@echo off
REM ---------------------------------------------------------------------------
REM Boot launcher for the ERP sync worker.
REM
REM Invoked by the "ERP Service" scheduled task (BootTrigger, registered
REM 2026-08-10). That task predates pm2 and this file used to run
REM `npm run start:dev` directly, which was a loaded gun:
REM
REM   * it starts a SECOND copy of the app outside pm2, on the same
REM     SYNC_PORT, so one copy dies with EADDRINUSE and whichever survives
REM     is the one pm2 is NOT watching — nothing restarts it when it falls
REM     over. ops/ensure-up.js carries the note from the last time this
REM     happened: the sync was down for eleven days;
REM     (the sweep itself is protected — the ingest lease lives in the database,
REM     in erp_raw.sync_lock, so a second worker stands down rather than
REM     sweeping alongside the first);
REM   * start:dev is a development server — it recompiles on file change and
REM     has no restart-on-crash at all;
REM   * it appended to startup.log forever. That file had reached 186 MB.
REM
REM It has not actually fired since 2026-09-15 (the task is still armed on
REM every boot, but its last result was 267014 = terminated). Disabling the
REM task needs an administrator, which the repo cannot assume it has. So the
REM launcher is pointed at the watchdog instead: whoever fires this now gets
REM the one correct outcome — the pm2-managed worker is running — and gets it
REM idempotently, so it is harmless to run when all is well.
REM
REM The practical effect is a second, independent boot path to the same place:
REM this task at boot, and the erp-sync-watchdog task every five minutes.
REM
REM If you would rather retire this task altogether, from an ELEVATED shell:
REM   Disable-ScheduledTask -TaskName 'ERP Service'
REM Leaving it enabled is fine while it points here.
REM ---------------------------------------------------------------------------
cd /d "%~dp0"
call "ops\ensure-erp-sync.cmd"
exit /b %errorlevel%
