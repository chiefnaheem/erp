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

  // ── Per-object digi-keys ────────────────────────────────────────────────
  // The ERP gives each object its own API key. Set the ones you have; any left
  // unset fall back to ERP_API_KEY above. Names match the object, not the method
  // (the same key is used for that object's .query and .read).
  @IsString()
  @IsOptional()
  ERP_API_KEY_CUSTOMER?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_CUSTOMER_CREDIT?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_SALES_ORDER?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_SALES_DELIVERY?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_SALES_RETURN?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_COLLECTION?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_AR_REFUND?: string;

  @IsString()
  @IsOptional()
  ERP_API_KEY_OTHER_RECEIVABLE?: string;

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

  @IsInt()
  @Min(1000)
  @IsOptional()
  @Transform(toInt)
  ERP_TIMEOUT_MS: number = 30_000;

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

  // Verbose request logging: when true, every ERP call logs its method, URL,
  // headers (with digi-key redacted), and full request body.
  // ⚠️ Defaults to TRUE for the current debugging phase — set ERP_VERBOSE=false
  // to quiet it down in normal operation.
  @IsBoolean()
  @IsOptional()
  @Transform(toBool)
  ERP_VERBOSE: boolean = true;

  // Logs a ready-to-run curl command for every ERP request — URL, ALL headers,
  // and the exact body.
  // ⚠️ This prints the REAL digi-key so the curl actually works, and it defaults
  // to TRUE for debugging — set ERP_LOG_CURL=false before running anywhere shared
  // so the API key doesn't end up in log files.
  @IsBoolean()
  @IsOptional()
  @Transform(toBool)
  ERP_LOG_CURL: boolean = true;

  // On startup, call EVERY ERP query endpoint once (read-only, pageSize 1) with
  // step-by-step logs — so you can immediately see which endpoints respond and
  // which fail (and why), without waiting for a scheduled sync.
  // ⚠️ Defaults to TRUE for debugging — set ERP_DEBUG_STARTUP=false to skip it.
  @IsBoolean()
  @IsOptional()
  @Transform(toBool)
  ERP_DEBUG_STARTUP: boolean = true;

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
  //   ERP_REGION_MAP={"Lagos":"LAGOS","West":"SOUTH_WEST","East":"SOUTH_EAST","North":"NORTH"}
  @IsString()
  @IsOptional()
  ERP_REGION_MAP?: string;
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
