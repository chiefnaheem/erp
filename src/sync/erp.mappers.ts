import { OrderStatus, Region } from '@prisma/client';

/**
 * Every unresolved question from CONTRACT.md is isolated here.
 *
 * The ERP docs leave several things undefined (the values of ApproveStatus, the
 * timezone of DOC_DATE, whether PIECES means cartons). Rather than scatter
 * guesses through the jobs, they are all concentrated in this file — so when the
 * ERP team answers, or the first live sweep reveals the truth, adapting is a
 * change here and nowhere else.
 */

/**
 * ApproveStatus → our OrderStatus.
 *
 * ⚠️ UNRESOLVED. The docs say ApproveStatus is a String but never enumerate its
 * values. Worse, it is an *approval* status while ours is a *fulfilment* status
 * (SHIPPED/DELIVERED almost certainly come from SALES_DELIVERY, not the order).
 *
 * Override without a code change via ERP_STATUS_MAP, e.g.
 *   ERP_STATUS_MAP={"Y":"PROCESSING","N":"PENDING","C":"CANCELLED"}
 *
 * An unmapped value is NOT guessed. Showing a customer a wrong order status is
 * worse than showing none, so the row is skipped and left queued — it projects
 * itself as soon as the mapping is filled in. The job logs every unmapped value
 * it saw, so one live run tells us exactly what to add.
 */
const DEFAULT_STATUS_MAP: Record<string, OrderStatus> = {
  // Real Digiwin E10 ApproveStatus values. 'Y' (approved) is confirmed in the
  // live data; 'N' (not yet approved) is the expected counterpart. An approved
  // sales order maps to PROCESSING — true fulfilment (SHIPPED/DELIVERED) is
  // tracked via SALES_DELIVERY, not the order's approval flag.
  //
  // Any other value stays unmapped and is skipped + logged, so a new status is
  // surfaced rather than silently guessed. Override via ERP_STATUS_MAP.
  Y: OrderStatus.PROCESSING,
  N: OrderStatus.PENDING,
};

export function buildStatusMap(raw?: string): Record<string, OrderStatus> {
  if (!raw) return DEFAULT_STATUS_MAP;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const map: Record<string, OrderStatus> = {};
    for (const [erpValue, ours] of Object.entries(parsed)) {
      if (ours in OrderStatus) {
        map[erpValue] = OrderStatus[ours as keyof typeof OrderStatus];
      }
    }
    return Object.keys(map).length ? map : DEFAULT_STATUS_MAP;
  } catch {
    return DEFAULT_STATUS_MAP;
  }
}

/** Returns null when the ERP value has no mapping — the caller must skip the row. */
export function toOrderStatus(
  approveStatus: unknown,
  map: Record<string, OrderStatus>,
): OrderStatus | null {
  if (typeof approveStatus !== 'string') return null;
  return map[approveStatus] ?? map[approveStatus.toUpperCase()] ?? null;
}

/**
 * ⚠️ TIMEZONE UNRESOLVED. The ERP's digi-host header declares +8 (it is a Chinese
 * Digiwin deployment) while Viju operates at +1. If the ERP returns naive local
 * timestamps, every date is 7 hours out.
 *
 * We do NOT silently shift anything — a wrong correction is harder to spot than
 * no correction. Dates are parsed as given; confirm the timezone with the ERP
 * team, then apply the offset here if one is needed.
 */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** ERP decimals arrive as either a number or a numeric string. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Order total = ex-tax amount + tax, both in OC (transaction currency).
 *
 * ⚠️ Assumes OC is always NGN. If the ERP ever books an order in another
 * currency this silently under/over-states the value — EXCHANGE_RATE is on the
 * row if we need to convert. Unconfirmed.
 */
export function purchaseTotalValue(row: Record<string, unknown>): number | null {
  const exTax = toNumber(row.AMT_UNINCLUDE_TAX_OC);
  if (exTax === null) return null;
  return exTax + (toNumber(row.TAX_OC) ?? 0);
}

/**
 * Total items on an order. The 2026-07-28 ERP update added QTY_TOTAL (total
 * business quantity) to the sales-order header, which is the right source — the
 * old PIECES field was 0 on ~all orders. Falls back to PIECES if QTY_TOTAL is
 * absent.
 */
export function purchaseTotalItems(row: Record<string, unknown>): number {
  return toNumber(row.QTY_TOTAL) ?? toNumber(row.PIECES) ?? 0;
}

// ─── Customer field resolution ───────────────────────────────────────────────
//
// The whole architecture assumes the ERP CAN supply a customer's phone and
// region — just not on the documented customer.query schema. Where they live is
// unknown until the probe finds them, so instead of hard-coding a field name we
// make the SOURCE FIELDS configurable. When the probe reveals, say, that phone
// sits on customer.read as CONTACT_TEL and region as a UDF, wiring it up is:
//
//   ERP_CUSTOMER_PHONE_FIELD=CONTACT_TEL
//   ERP_CUSTOMER_REGION_FIELD=UDF021
//   ERP_REGION_MAP={"Lagos":"LAGOS","West":"SOUTH_WEST",...}
//
// ...and customer creation switches on. No code change.

export interface CustomerFieldMap {
  phoneField?: string;
  regionField?: string;
  regionMap: Record<string, Region>;
  regionDefault: Region | null;
}

// Built-in mapping for the ERP's (Chinese) region values, per the ERP team's
// key: 东部=East, 南部=South, 西部=West, 北部=North, 加纳=Ghana.
// Nigeria has no plain "South" region in our enum, so 南部(South) → SOUTH_WEST as
// the closest fit; override any of these via ERP_REGION_MAP.
const BUILTIN_REGION_MAP: Record<string, Region> = {
  '北部': Region.NORTH, // North
  '东部': Region.SOUTH_EAST, // East
  '西部': Region.SOUTH_WEST, // West
  '南部': Region.SOUTH_WEST, // South (no exact enum match)
  '加纳': Region.LAGOS, // Ghana (not a NG region — placeholder)
  EAST: Region.SOUTH_EAST,
  WEST: Region.SOUTH_WEST,
  NORTH: Region.NORTH,
  SOUTH: Region.SOUTH_WEST,
};

export function buildCustomerFieldMap(env: {
  phoneField?: string;
  regionField?: string;
  regionMap?: string;
  regionDefault?: string;
}): CustomerFieldMap {
  const regionMap: Record<string, Region> = { ...BUILTIN_REGION_MAP };
  if (env.regionMap) {
    try {
      const parsed = JSON.parse(env.regionMap) as Record<string, string>;
      for (const [erpValue, ours] of Object.entries(parsed)) {
        if (ours in Region) regionMap[erpValue] = Region[ours as keyof typeof Region];
      }
    } catch {
      // keep built-ins
    }
  }
  const regionDefault =
    env.regionDefault && env.regionDefault in Region
      ? Region[env.regionDefault as keyof typeof Region]
      : null;
  return {
    phoneField: env.phoneField,
    regionField: env.regionField,
    regionMap,
    regionDefault,
  };
}

export interface ResolvedCustomer {
  name: string | null;
  phone: string | null;
  region: Region | null;
  /** True once a phone SOURCE is configured — i.e. the app may create, not just update. */
  canCreate: boolean;
}

// As of the 2026-07-28 ERP update, customer.query returns PhoneNumber and Region
// directly, so these are the defaults. ERP_CUSTOMER_PHONE_FIELD /
// ERP_CUSTOMER_REGION_FIELD still override them if the ERP ever renames them.
const DEFAULT_PHONE_FIELD = 'PhoneNumber';
const DEFAULT_REGION_FIELD = 'Region';

export function resolveCustomer(
  payload: Record<string, unknown>,
  map: CustomerFieldMap,
): { name: string | null; phone: string | null; region: Region | null; canCreate: boolean; rawRegion: string | null } {
  const name =
    (payload.CUSTOMER_FULL_NAME as string) ??
    (payload.CUSTOMER_NAME as string) ??
    null;

  const phoneField = map.phoneField ?? DEFAULT_PHONE_FIELD;
  const regionField = map.regionField ?? DEFAULT_REGION_FIELD;

  const phone = normalisePhone(payload[phoneField]);

  const rawRegion =
    typeof payload[regionField] === 'string' && (payload[regionField] as string).trim()
      ? (payload[regionField] as string).trim()
      : null;
  // Resolve via map, else fall back to the configured default (so an empty or
  // unmapped ERP region doesn't block creation). Only truly unresolved when no
  // default is set.
  const region =
    (rawRegion ? resolveRegion(rawRegion, map.regionMap) : null) ?? map.regionDefault;

  return {
    name,
    phone,
    region,
    rawRegion,
    // phone + region are both required with no schema default, so the projection
    // verifies both are present before inserting. With PhoneNumber/Region now on
    // the customer object, creation is possible by default.
    canCreate: true,
  };
}

/**
 * Map an ERP region string onto our enum. Tries the configured ERP_REGION_MAP
 * first, then falls back to matching our own enum values directly (so a value
 * like "LAGOS" or "South West" → SOUTH_WEST works without a full map). Returns
 * null when it can't be resolved, so the projection can log it and skip.
 */
function resolveRegion(
  value: string,
  regionMap: Record<string, Region>,
): Region | null {
  if (regionMap[value]) return regionMap[value];

  const normalized = value.toUpperCase().replace(/[\s-]+/g, '_');
  if (normalized in Region) return Region[normalized as keyof typeof Region];

  return null;
}

function normalisePhone(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).replace(/[^\d+]/g, '');
  return digits.length >= 7 ? digits : null;
}
