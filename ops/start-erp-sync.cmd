@echo off
REM ---------------------------------------------------------------------------
REM Bring the erp-sync worker back up after a reboot / logon.
REM
REM Run by the Scheduled Task "erp-sync-resurrect" (see ops/README-service.md).
REM `pm2 resurrect` starts the pm2 daemon if needed and relaunches every process
REM saved by `pm2 save` — erp-sync plus the pm2-logrotate module.
REM
REM Waits first: on a fresh boot the network stack (and the route to the ERP and
REM the database) is often not ready for a few seconds, and a worker that starts
REM into a dead network just logs failures until its next tick.
REM ---------------------------------------------------------------------------
timeout /t 30 /nobreak >nul

set "PM2_CMD=%APPDATA%\npm\pm2.cmd"
if not exist "%PM2_CMD%" (
  echo [erp-sync] pm2 not found at %PM2_CMD% >> "C:\Users\ServerPC\Documents\erp\logs\resurrect.log"
  exit /b 1
)

echo [%date% %time%] resurrecting pm2 processes >> "C:\Users\ServerPC\Documents\erp\logs\resurrect.log"
call "%PM2_CMD%" resurrect >> "C:\Users\ServerPC\Documents\erp\logs\resurrect.log" 2>&1
echo [%date% %time%] done (exit %errorlevel%) >> "C:\Users\ServerPC\Documents\erp\logs\resurrect.log"
exit /b %errorlevel%
