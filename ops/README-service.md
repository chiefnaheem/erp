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
