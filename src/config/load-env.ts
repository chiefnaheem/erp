/**
 * Load this app's .env into process.env BEFORE the Nest module graph is built.
 *
 * ConfigModule.forRoot() reads the file too, but it only runs once AppModule's
 * decorator body is evaluated — and ES imports are hoisted, so every imported
 * module has already been evaluated by then. Anything that reads process.env at
 * IMPORT time therefore sees nothing.
 *
 * That is not hypothetical: SyncScheduler's `@Cron(process.env.ERP_SYNC_CRON ||
 * <fallback>)` decorators are evaluated at import time. Without this file
 * ERP_SYNC_CRON was always undefined, so the ingest sweep silently ran on the
 * 6-hourly fallback instead of the configured cadence, and a restart could go
 * hours without fetching anything.
 *
 * Must be the FIRST import in main.ts. dotenv does not overwrite variables that
 * are already set in the real environment, so a container/pm2-supplied value
 * still wins — the same precedence ConfigModule applies.
 */
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';

// From dist/config/ back up to the app root, so the path holds whatever
// directory the process was launched from. `quiet` suppresses dotenv's own
// startup banner, which would otherwise print above Nest's first log line.
loadDotenv({ path: join(__dirname, '..', '..', '.env'), quiet: true });
