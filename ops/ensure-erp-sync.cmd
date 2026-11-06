@echo off
REM ---------------------------------------------------------------------------
REM Keep the erp-sync worker running. Registered as a REPEATING scheduled task
REM (see ops/README-service.md) because pm2 restarts the app but nothing
REM restarted pm2 — and when its daemon stopped on 2026-10-26 the sync was down
REM for eleven days before anyone noticed.
REM
REM Safe to run every few minutes: when all is well it costs one pm2 call and
REM one HTTP probe, and every branch is idempotent.
REM
REM No output redirection here: ensure-up.js writes logs\ensure-up.log itself,
REM with timestamps. Redirecting as well wrote every line twice, once stamped
REM and once not.
REM ---------------------------------------------------------------------------
cd /d "%~dp0.."
node "ops\ensure-up.js"
exit /b %errorlevel%
