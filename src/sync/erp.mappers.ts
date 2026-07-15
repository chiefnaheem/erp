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
  // Placeholders only — none of these are confirmed against the real ERP.
  PENDING: OrderStatus.PENDING,
  PROCESSING: OrderStatus.PROCESSING,
  SHIPPED: OrderStatus.SHIPPED,
  DELIVERED: OrderStatus.DELIVERED,
  CANCELLED: OrderStatus.CANCELLED,
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
 * ⚠️ AMBIGUOUS. PIECES is documented only as "Number of pieces" — it may be
 * cartons or it may be the line count. Our totalItems is shown to customers, so
 * this matters. Treated as a count until confirmed.
 */
export function purchaseTotalItems(row: Record<string, unknown>): number {
  return toNumber(row.PIECES) ?? 0;
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
}

export function buildCustomerFieldMap(env: {
  phoneField?: string;
  regionField?: string;
  regionMap?: string;
}): CustomerFieldMap {
  let regionMap: Record<string, Region> = {};
  if (env.regionMap) {
    try {
      const parsed = JSON.parse(env.regionMap) as Record<string, string>;
      for (const [erpValue, ours] of Object.entries(parsed)) {
        if (ours in Region) regionMap[erpValue] = Region[ours as keyof typeof Region];
      }
    } catch {
      regionMap = {};
    }
  }
  return {
    phoneField: env.phoneField,
    regionField: env.regionField,
    regionMap,
  };
}

export interface ResolvedCustomer {
  name: string | null;
  phone: string | null;
  region: Region | null;
  /** True once a phone SOURCE is configured — i.e. the app may create, not just update. */
  canCreate: boolean;
}

export function resolveCustomer(
  payload: Record<string, unknown>,
  map: CustomerFieldMap,
): ResolvedCustomer {
  const name =
    (payload.CUSTOMER_FULL_NAME as string) ??
    (payload.CUSTOMER_NAME as string) ??
    null;

  const phone = map.phoneField ? normalisePhone(payload[map.phoneField]) : null;

  const region =
    map.regionField && typeof payload[map.regionField] === 'string'
      ? (map.regionMap[payload[map.regionField] as string] ?? null)
      : null;

  return {
    name,
    phone,
    region,
    // Customer.phone AND Customer.region are both required with no schema default,
    // so a real INSERT needs both resolved. canCreate signals only that we've been
    // TOLD where to find them (a phone field is configured); the projection still
    // verifies both values are actually present before inserting.
    canCreate: Boolean(map.phoneField),
  };
}

function normalisePhone(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).replace(/[^\d+]/g, '');
  return digits.length >= 7 ? digits : null;
}
