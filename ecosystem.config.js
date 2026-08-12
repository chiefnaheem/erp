// pm2 process config for the erp-sync worker.
//
// Why pm2: the worker was crashing mid-sweep (flaky DB, memory pressure on the
// box) and, with no process manager, stayed down. pm2 restarts it automatically.
// Combined with the app's boot-time DB-connect retry and the per-job resume
// cursor, a crash now self-heals: pm2 relaunches → the app reconnects → the
// ingest RESUMES from the page it reached, so big sweeps eventually complete
// across restarts instead of failing forever.
//
// Usage (from the repo root on the server):
//   npm run build
//   pm2 start ecosystem.config.js
//   pm2 save                # persist the process list across reboots
//   pm2 logs erp-sync       # tail logs
//   pm2 restart erp-sync    # after a git pull + npm run build

module.exports = {
  apps: [
    {
      name: 'erp-sync',
      script: 'dist/main.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      // Exponential backoff on repeated crashes: if the DB is down, don't hammer
      // restarts — back off (up to ~15s) and keep trying until it recovers.
      exp_backoff_restart_delay: 2000,
      max_restarts: 1000,
      min_uptime: '20s',

      // The box has been memory-starved (OOM-killed nginx/Postgres before).
      // Recycle the worker if it balloons, rather than letting it get OOM-killed.
      max_memory_restart: '400M',

      watch: false,
      time: true, // timestamp log lines
      merge_logs: true,
      out_file: 'logs/erp-sync.out.log',
      error_file: 'logs/erp-sync.err.log',

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
