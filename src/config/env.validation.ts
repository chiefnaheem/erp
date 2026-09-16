import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  validateSync,
} from 'class-validator';

const toBool = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase() === 'true' : Boolean(value);

const toInt = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : Number(value);

export class EnvVars {
  // Deliberately NOT named PORT. The worker shares process.env with the main
  // API's root .env (Prisma loads it on import), and NestJS ConfigModule lets
  // process.env override .env files — so a key named PORT would always resolve
  // to the API's 3025 and the two apps would fight over one socket. Any
  // worker-specific key must have a name the root .env does not define.
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  @Transform(toInt)
  SYNC_PORT: number = 3100;

  // Shared with the main API — the worker writes into the same database.
  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  @IsUrl({ require_tld: false })
  ERP_BASE_URL: string;

  // Fallback digi-key, used for any object that has no object-specific key set.
  // The ERP issues a DIFFERENT key per object, so the per-object keys below take
  // precedence; this is the default for anything not overridden.
  @IsString()
  @IsNotEmpty()
  ERP_API_KEY: string;

  // ── Per-method / per-object digi-keys ───────────────────────────────────
  // The API doc shows a DIFFERENT digi-key for every method — including .query
  // vs .read of the same object. Keys are resolved most-specific first:
  //
  //   ERP_API_KEY_<OBJECT>_QUERY  →  ERP_API_KEY_<OBJECT>  →  ERP_API_KEY
  //
  // So the object-level keys below still work for a deployment that only calls
  // .query (which is all the sync does); add the _QUERY / _READ variants only
  // where the ERP actually issued separate keys. Objects: CUSTOMER,
  // CUSTOMER_CREDIT, SALES_ORDER, SALES_DELIVERY,
  // SALES_RETURN, COLLECTION, AR_REFUND, AR_TRANSFER, OTHER_RECEIVABLE.
  @IsString()
  @IsOptional()
  ERP_API_KEY_CUSTOMER?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_CUSTOMER_QUERY?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_CUSTOMER_READ?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_CUSTOMER_CREDIT?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_CUSTOMER_CREDIT_QUERY?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_CUSTOMER_CREDIT_READ?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_SALES_ORDER?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_SALES_ORDER_QUERY?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_SALES_ORDER_READ?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_SALES_DELIVERY?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_SALES_DELIVERY_QUERY?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_SALES_DELIVERY_READ?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_SALES_RETURN?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_SALES_RETURN_QUERY?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_SALES_RETURN_READ?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_COLLECTION?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_COLLECTION_QUERY?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_COLLECTION_READ?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_AR_REFUND?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_AR_REFUND_QUERY?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_AR_REFUND_READ?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_AR_TRANSFER?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_AR_TRANSFER_QUERY?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_AR_TRANSFER_READ?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_OTHER_RECEIVABLE?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_OTHER_RECEIVABLE_QUERY?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_OTHER_RECEIVABLE_READ?: string;

  // Echoed inside the digi-host / digi-service JSON headers.
  @IsString()
  @IsOptional()
  ERP_SERVER_IP: string = '127.0.0.1';

  @IsString()
  @IsOptional()
  ERP_PRODUCT: string = 'YVIJUCRM';

  @IsString()
  @IsOptional()
  ERP_HOST_VERSION: string = '5.7';

  @IsString()
  @IsOptional()
  // Changed from 'CRM' to 'dcms' in the 2026-07-28 ERP API update (the `acct`
  // value in the digi-host header). Override in .env if the ERP changes it again.
  ERP_ACCOUNT: string = 'CRM';

  // The ERP is a Digiwin deployment declaring +8; Viju runs at +1. Unresolved —
  // see CONTRACT.md. Kept configurable so we can correct it without a code change.
  @IsString()
  @IsOptional()
  ERP_TIMEZONE: string = '+8';

  @IsString()
  @IsOptional()
  ERP_LANG: string = 'zh_CN';

  // The ERP was observed to require a python-requests-style User-Agent to
  // respond; some gateways reject an unknown/blank UA. Overridable.
  @IsString()
  @IsOptional()
  ERP_USER_AGENT: string = 'python-requests/2.34.2';

  // Optional explicit Host header (e.g. "192.168.25.241:9900"). Normally the HTTP
  // client derives Host from ERP_BASE_URL; set this only if the server needs a
  // Host that differs from the URL (e.g. behind a proxy or IP-based vhost).
  @IsString()
  @IsOptional()
  ERP_HOST_HEADER?: string;

  // The ERP team measured a single E10 query at ~60s. A 30s timeout meant we
  // ABANDONED requests that were still executing on their side and immediately
  // sent another — multiplying the load we were complaining about. Must stay
  // comfortably above their real response time.
  @IsInt()
  @Min(1000)
  @IsOptional()
  @Transform(toInt)
  ERP_TIMEOUT_MS: number = 120_000;

  @IsInt()
  @Min(0)
  @Max(10)
  @IsOptional()
  @Transform(toInt)
  ERP_MAX_RETRIES: number = 3;

  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  @Transform(toInt)
  ERP_PAGE_SIZE: number = 100; 

  // How many times to retry a single page (transient ERP/transport error) before
  // skipping it and continuing the sweep. Keeps one bad page from failing the
  // whole sweep.
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  @Transform(toInt)
  ERP_PAGE_RETRIES: number = 3;

  // How many ingest sweeps run at once. All 8 at once overloaded the flaky DB
  // into half-open hangs; 3 keeps each sweep likelier to complete. Set to 1 for
  // fully sequential (gentlest on the DB, slowest wall-clock).
  // ONE object at a time. The ERP reported requests arriving every ~2s against a
  // ~60s response time, backlogging their server. Parallel sweeps are the last
  // thing that endpoint needs.
  @IsInt()
  @Min(1)
  @Max(8)
  @IsOptional()
  @Transform(toInt)
  ERP_INGEST_CONCURRENCY: number = 1;

  // Ingest escalation: run every 15 min for the first ERP_INGEST_FAST_MINUTES
  // after boot (quick catch-up), then at most once per ERP_INGEST_SLOW_MINUTES
  // (hourly) to spare the DB. Default: fast for 1h, then hourly.
  @IsInt()
  @Min(0)
  @IsOptional()
  @Transform(toInt)
  ERP_INGEST_FAST_MINUTES: number = 60;

  @IsInt()
  @Min(1)
  @IsOptional()
  @Transform(toInt)
  ERP_INGEST_SLOW_MINUTES: number = 60;

  // Pre-flight request logging: before EVERY ERP call, log the service name, the
  // exact headers (secrets masked) and the exact body, in one fixed layout.
  // ON by default so the log always shows precisely what was sent — which is what
  // an ERP-side investigation asks for first.
  //
  // ⚠️ It logs once per request, and a full sweep is thousands of requests. Set
  // ERP_LOG_REQUESTS=false to quiet it once an integration is stable.
  @IsBoolean()
  @IsOptional()
  @Transform(toBool)
  ERP_LOG_REQUESTS: boolean = true;

  // Print the digi-key IN FULL in the request log instead of masked. For testing
  // only — it writes a live credential to the log file. OFF by default; the
  // client warns once per process while it is on.
  @IsBoolean()
  @IsOptional()
  @Transform(toBool)
  ERP_LOG_KEY_PLAIN: boolean = false;

  // Kept for back-compat: this used to be the only switch for request logging.
  // ERP_LOG_REQUESTS now covers it and defaults ON, but setting ERP_VERBOSE=true
  // still forces request logging even if ERP_LOG_REQUESTS is turned off.
  @IsBoolean()
  @IsOptional()
  @Transform(toBool)
  ERP_VERBOSE: boolean = false;

  // Logs a ready-to-run curl for every request. OFF by default. ⚠️ When on, it
  // prints the REAL digi-key, so only enable it for a short local debugging session.
  @IsBoolean()
  @IsOptional()
  @Transform(toBool)
  ERP_LOG_CURL: boolean = false;

  // On startup, probe EVERY ERP query endpoint once (read-only) with step logs.
  // OFF by default; a handy one-shot health check when bringing up the integration.
  @IsBoolean()
  @IsOptional()
  @Transform(toBool)
  ERP_DEBUG_STARTUP: boolean = false;

  // ── ERP politeness / incremental sync ───────────────────────────────────
  // Pause between PAGES of a sweep. The ERP measured our requests arriving every
  // ~2s while each of their responses takes ~60s, so pages piled up faster than
  // they could be served. This is the single most direct control on that.
  @IsInt()
  @Min(0)
  @IsOptional()
  @Transform(toInt)
  ERP_PAGE_DELAY_MS: number = 1500;

  // Pull only rows changed since the last successful sweep, instead of every row
  // every time. Safe to leave on before the ERP exposes the field: a sweep that
  // is rejected for an unknown column falls back to a full sweep automatically
  // (see IngestJob) and starts filtering by itself once the ERP deploys it.
  @IsBoolean()
  @IsOptional()
  @Transform(toBool)
  ERP_INCREMENTAL: boolean = true;

  // The column the incremental filter compares against.
  @IsString()
  @IsOptional()
  ERP_INCREMENTAL_FIELD: string = 'LastModifiedDate';

  // Re-fetch this much overlap either side of the watermark. Covers clock skew
  // between us (+1) and the ERP (+8 in its own headers), and rows written while
  // a sweep was mid-flight. Cheap: overlapping rows hash-match and are skipped.
  @IsInt()
  @Min(0)
  @IsOptional()
  @Transform(toInt)
  ERP_INCREMENTAL_OVERLAP_MINUTES: number = 30;

  // How long ONE object may sweep before it pauses and lets the others run.
  // A full sales-order sweep is 8-14 hours; without this it holds the ingest lock
  // for that whole time and every other object is starved (customer_credit went
  // four days without a refresh). The page cursor makes pausing free: the sweep
  // resumes exactly where it stopped. 0 disables the limit.
  @IsInt()
  @Min(0)
  @IsOptional()
  @Transform(toInt)
  ERP_SWEEP_MAX_MINUTES: number = 10;

  // Force a full, unfiltered sweep this often regardless of the watermark.
  // The backstop for two things an incremental filter cannot see: rows the ERP
  // changes WITHOUT moving LastModifiedDate, and back-dated edits. 0 disables it.
  @IsInt()
  @Min(0)
  @IsOptional()
  @Transform(toInt)
  ERP_FULL_SWEEP_DAYS: number = 7;

  // After a FULL sweep, delete rows the ERP no longer returns. This is what
  // removes records deleted in the ERP, and the ghosts left behind when the ERP
  // edits a field that forms part of our key (customer_credit moved five
  // customers from EFFECTIVE_DATE 0001-01-01 to 2026-09-02, and the old rows
  // stayed behind). Never applied to incremental sweeps.
  @IsBoolean()
  @IsOptional()
  @Transform(toBool)
  ERP_RECONCILE_DELETES: boolean = true;

  // Jobs that ALWAYS sweep in full instead of incrementally. Only a full sweep
  // reconciles, so these objects can never accumulate ghost rows — which is what
  // lets customer_credit key on CREDIT_AMT1, sometimes the only thing telling two
  // real records apart. Keep the million-row objects OUT of this list.
  @IsString()
  @IsOptional()
  ERP_FULL_SWEEP_JOBS: string =
    'ingest:customer_credit,ingest:sales_return,ingest:ar_refund,ingest:other_receivable,ingest:ar_transfer,ingest:customer';

  // Default gap between sweeps of ONE object. Each object also gets its own
  // schedule (ERP_INTERVAL_<OBJECT>) and a staggered start minute, so the eight
  // never run together.
  @IsInt()
  @Min(1)
  @IsOptional()
  @Transform(toInt)
  ERP_INGEST_INTERVAL_MINUTES: number = 60;

  // Per-object overrides, in minutes. Unset = ERP_INGEST_INTERVAL_MINUTES.
  @IsInt() @Min(1) @IsOptional() @Transform(toInt) ERP_INTERVAL_CUSTOMER?: number;
  @IsInt() @Min(1) @IsOptional() @Transform(toInt) ERP_INTERVAL_CUSTOMER_CREDIT?: number;
  @IsInt() @Min(1) @IsOptional() @Transform(toInt) ERP_INTERVAL_SALES_ORDER?: number;
  @IsInt() @Min(1) @IsOptional() @Transform(toInt) ERP_INTERVAL_SALES_DELIVERY?: number;
  @IsInt() @Min(1) @IsOptional() @Transform(toInt) ERP_INTERVAL_SALES_RETURN?: number;
  @IsInt() @Min(1) @IsOptional() @Transform(toInt) ERP_INTERVAL_COLLECTION?: number;
  @IsInt() @Min(1) @IsOptional() @Transform(toInt) ERP_INTERVAL_AR_REFUND?: number;
  @IsInt() @Min(1) @IsOptional() @Transform(toInt) ERP_INTERVAL_OTHER_RECEIVABLE?: number;
  @IsInt() @Min(1) @IsOptional() @Transform(toInt) ERP_INTERVAL_AR_TRANSFER?: number;

  // Watchdog: if the database stays unreachable this many minutes, exit so the
  // process manager (pm2 / Windows service) restarts the worker with a fresh
  // client. The in-process retries handle ordinary blips; this is the backstop
  // for a wedged client that reconnecting cannot fix. 0 disables it.
  @IsInt()
  @Min(0)
  @IsOptional()
  @Transform(toInt)
  DB_WATCHDOG_MINUTES: number = 10;

  // Master kill switch: when false the app boots and serves /health but runs no
  // sync jobs. Lets us deploy the worker before the ERP is reachable.
  @IsBoolean()
  @IsOptional()
  @Transform(toBool)
  SYNC_ENABLED: boolean = true;

  // Every tick is a FULL sweep (the ERP cannot do deltas), so the default is
  // deliberately conservative — 15 minutes, not 1.
  @IsString()
  @IsOptional()
  ERP_SYNC_CRON: string = '0 */15 * * * *';

  // Projection (erp_raw → public) runs on its OWN schedule, decoupled from the
  // heavy ingest sweep, so the backlog drains independently. Every 3 min default.
  @IsString()
  @IsOptional()
  ERP_PROJECT_CRON: string = '0 */3 * * * *';

  // Rows projected per batch while draining the backlog.
  @IsInt()
  @Min(1)
  @Max(10000)
  @IsOptional()
  @Transform(toInt)
  ERP_PROJECT_BATCH: number = 1000;

  // Lease length for the cross-replica sync lock. Must comfortably exceed the
  // longest expected cycle, or a slow sweep would have its lock stolen mid-run.
  @IsInt()
  @Min(1)
  @IsOptional()
  @Transform(toInt)
  SYNC_LOCK_MINUTES: number = 30;

  /**
   * ⚠️ The ERP's ApproveStatus values are undocumented. Until we know them, every
   * sales order is skipped as unmappable (deliberately — a wrong order status is
   * worse than a missing one). The first real sweep logs the values it saw; put
   * them here and the queued orders project themselves.
   *
   *   ERP_STATUS_MAP={"Y":"PROCESSING","N":"PENDING","C":"CANCELLED"}
   */
  @IsString()
  @IsOptional()
  ERP_STATUS_MAP?: string;

  // ── Customer phone/region source ────────────────────────────────────────
  // The documented customer schema has neither, but the app is ERP-driven and
  // needs both (phone is the login id; region is required). These name the ERP
  // payload fields that actually hold them, once the probe finds them. Leaving
  // ERP_CUSTOMER_PHONE_FIELD unset keeps customer projection UPDATE-ONLY.
  @IsString()
  @IsOptional()
  ERP_CUSTOMER_PHONE_FIELD?: string;

  @IsString()
  @IsOptional()
  ERP_CUSTOMER_REGION_FIELD?: string;

  // Maps ERP region values onto our enum, e.g.
  //   ERP_REGION_MAP={"南部":"SOUTH_WEST","北部":"NORTH","西部":"SOUTH_WEST"}
  @IsString()
  @IsOptional()
  ERP_REGION_MAP?: string;

  // Fallback region when the ERP value is empty or unmapped. The ERP's region
  // data is largely empty/Chinese, and region is REQUIRED with no schema default,
  // so without a fallback nearly all customers are un-creatable. Setting this
  // unblocks customer creation; accuracy can be refined via ERP_REGION_MAP later.
  //   ERP_REGION_DEFAULT=LAGOS
  //
  // ⚠️ SUPERSEDED. A distributor's region comes from the numeric BP_CLUSTER_CODE
  // (see ERP_CLUSTER_REGION_MAP), not from the customer's `Region` field, which
  // is blank on essentially every row. The projector never defaults a region:
  // region is NOT NULL and half the portal filters on it, so a guess is a wrong
  // answer that spreads. Kept only so an existing .env does not fail validation.
  @IsString()
  @IsOptional()
  ERP_REGION_DEFAULT?: string;

  // ── Projection ───────────────────────────────────────────────────────────

  // BP_CLUSTER_CODE → Region. The ERP's cluster code is both the region key AND
  // the tenant discriminator: the same ERP serves other companies, whose
  // customers carry codes outside this map and are quarantined rather than
  // projected. Built-in: {"1":"LAGOS","2":"EASTERN","3":"SOUTH_SOUTH",
  //                       "4":"WESTERN","5":"NORTH"}
  @IsString()
  @IsOptional()
  ERP_CLUSTER_REGION_MAP?: string;

  // Ignore the changed_at watermark and re-project the whole feed on every run.
  //
  // Normally unnecessary — a job with no row in erp_raw.projection_watermark
  // full-scans by itself, so the first run after a deploy backfills without
  // anyone asking. To force one later, prefer deleting that job's row:
  //   DELETE FROM erp_raw.projection_watermark WHERE job = 'project:customer';
  @IsBoolean()
  @IsOptional()
  @Transform(toBool)
  ERP_PROJECT_FULL: boolean = false;

  // Whether the ERP owns Customer.phone on rows that ALREADY exist. Per the
  // field-ownership table it does, so this defaults to true. Turn it off if the
  // ERP's phone data is worse than the app's: customers being created still get
  // their phone from the ERP (it is NOT NULL and it is the login), but existing
  // customers keep the number they have.
  @IsBoolean()
  @IsOptional()
  @Transform(toBool)
  ERP_CUSTOMER_PHONE_UPDATE: boolean = true;

  // Create customers whose ERP PhoneNumber is unusable (blank, or — for 1,844 of
  // the 1,851 Viju distributors — shared with everyone else) using a
  // non-dialable 'erp:<CUSTOMER_CODE>' placeholder instead of quarantining them.
  //
  // The placeholder cannot collide with a real number and cannot receive an OTP,
  // so the distributor becomes visible to admins, regional admins and account
  // officers WITHOUT a credential anyone could log in with. A later run replaces
  // it the moment the ERP sends a real number.
  //
  // OFF by default: phone is the customer login, and inventing one is a product
  // decision, not a sync default. Turn it on to reach parity with the feed
  // before the ERP's phone data is fixed.
  @IsBoolean()
  @IsOptional()
  @Transform(toBool)
  ERP_CUSTOMER_SYNTHETIC_PHONE: boolean = false;

  // A normalised phone must match this POSIX regex to be written to
  // Customer.phone. Default is a Nigerian mobile in E.164:
  //   ^[+]234[789][01][0-9]{8}$
  // phone is the login AND the OTP target, so a malformed number is worse than
  // the one already on the record. Override only if the ERP starts carrying
  // numbers from another country.
  @IsString()
  @IsOptional()
  ERP_PHONE_PATTERN?: string;

  // Statement timeout for a projection pass. Generous, because the first
  // backfill run touches the whole customer set.
  //
  // ⚠️ PrismaService pins socket_timeout=120 on the connection string, so the
  // CLIENT gives up on a single statement at ~120s regardless. Raising this
  // past that only helps if socket_timeout is raised with it.
  @IsInt()
  @Min(1000)
  @IsOptional()
  @Transform(toInt)
  ERP_PROJECT_STATEMENT_TIMEOUT_MS: number = 300_000;

  // How long a projection transaction may stay open before Prisma aborts it.
  @IsInt()
  @Min(1000)
  @IsOptional()
  @Transform(toInt)
  ERP_PROJECT_TX_TIMEOUT_MS: number = 600_000;

  // Raw rows one purchase projection may read.
  //
  // The selector re-reads every row with projected_at IS NULL, and 1.94M of the
  // 1.99M sales-order rows are permanently in that state (their distributor has
  // not onboarded). Unbounded, that re-read spilled 890 GB of temp files in
  // twenty hours on 2026-09-16 and filled the database server's disk.
  //
  // A run now takes the next slice of this many rows by id and records where it
  // stopped (erp_raw.sync_cursor, key "scan:project:purchase"), wrapping to the
  // start when it reaches the end — and only the wrapping run advances the
  // watermark. Whole documents are still aggregated even when their lines
  // straddle a slice boundary: the line pass re-reads every line of each
  // document the slice names.
  @IsInt()
  @Min(1000)
  @IsOptional()
  @Transform(toInt)
  ERP_PROJECT_MAX_ROWS_PER_RUN: number = 100_000;

  // ── Viju backend API (post-run reconcile calls) ──────────────────────────
  //
  // After a clean projection the worker POSTs to two endpoints that re-derive
  // what the backend owns. Both take no body and are safe to call repeatedly:
  //
  //   POST /api/v1/erp/sync/account-balance
  //   POST /api/v1/erp/sync/order-status
  //
  // The second one is load-bearing: this service does not write Purchase.status
  // on update (the app's LOADED / DISPATCHED states have no ERP counterpart and
  // would be clobbered), so the backend's reconciler is what carries an ERP
  // status change through. Leave both unset to skip the calls entirely.
  @IsUrl({ require_tld: false })
  @IsOptional()
  VIJU_API_BASE_URL?: string;

  // The BACKEND's own ERP_API_KEY — the shared secret it expects in x-api-key.
  // Deliberately NOT this app's ERP_API_KEY, which is the ERP's digi-key: two
  // different secrets that happen to share a name across the two repos.
  @IsString()
  @IsOptional()
  VIJU_API_KEY?: string;

  @IsInt()
  @Min(1000)
  @IsOptional()
  @Transform(toInt)
  VIJU_API_TIMEOUT_MS: number = 30_000;
}

export function validateEnv(raw: Record<string, unknown>): EnvVars {
  const parsed = plainToInstance(EnvVars, raw, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(parsed, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors
      .map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return parsed;
}
