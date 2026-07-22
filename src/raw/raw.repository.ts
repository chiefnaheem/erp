import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type ErpObjectType =
  | 'CUSTOMER'
  | 'CUSTOMER_CREDIT'
  | 'SALES_ORDER'
  | 'SALES_DELIVERY'
  | 'SALES_RETURN'
  | 'COLLECTION'
  | 'AR_REFUND'
  | 'OTHER_RECEIVABLE';

/**
 * Each ERP object is dumped into its OWN table under erp_raw, so every
 * endpoint's responses land separately (raw_customer, raw_sales_order, …).
 *
 * This is also the injection guard: table names in the dynamic SQL below only
 * ever come from this fixed map, never from anything user- or ERP-supplied.
 */
const RAW_TABLE: Record<ErpObjectType, string> = {
  CUSTOMER: 'raw_customer',
  CUSTOMER_CREDIT: 'raw_customer_credit',
  SALES_ORDER: 'raw_sales_order',
  SALES_DELIVERY: 'raw_sales_delivery',
  SALES_RETURN: 'raw_sales_return',
  COLLECTION: 'raw_collection',
  AR_REFUND: 'raw_ar_refund',
  OTHER_RECEIVABLE: 'raw_other_receivable',
};

export interface RawUpsertResult {
  /** Rows the ERP handed us this sweep. */
  fetched: number;
  /** Rows whose content actually moved — the only ones worth projecting. */
  changed: number;
}

export interface PendingRecord {
  id: bigint;
  erp_key: string;
  payload: Record<string, unknown>;
}

/** Chunk size for the upsert transaction — big enough to be fast, small enough
 *  not to hold a long transaction open against a shared database. */
const CHUNK = 200;

@Injectable()
export class RawRepository {
  private readonly logger = new Logger(RawRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The (allowlisted) bare table name for an object. Throws on an unknown type. */
  private table(objectType: ErpObjectType): string {
    const name = RAW_TABLE[objectType];
    if (!name) throw new Error(`Unknown ERP object type: ${objectType}`);
    return name;
  }

  /** Public accessor for the object's raw table name — used in logging. */
  tableFor(objectType: ErpObjectType): string {
    return this.table(objectType);
  }

  /**
   * Canonical hash of an ERP payload.
   *
   * Keys are sorted recursively before hashing: the ERP gives no guarantee about
   * field order, and an order-sensitive hash would report every row as "changed"
   * on every sweep — defeating the entire point of the hash.
   */
  static hash(payload: unknown): string {
    return createHash('sha256').update(canonicalise(payload)).digest('hex');
  }

  /**
   * Store a sweep's worth of ERP rows into the object's own table.
   *
   * Unchanged rows have their last_seen_at bumped but are NOT marked for
   * re-projection. Changed rows have projected_at reset to NULL, which is what
   * puts them back in the projection queue.
   */
  async upsertMany(
    objectType: ErpObjectType,
    rows: Record<string, unknown>[],
    keyOf: (row: Record<string, unknown>) => string | undefined,
  ): Promise<RawUpsertResult> {
    const t = this.table(objectType); // bare name, e.g. raw_customer

    // Keep only rows with a key, deduped by key (a multi-row ON CONFLICT cannot
    // touch the same target row twice in one statement). Last write wins.
    const keyed = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const key = keyOf(row);
      if (!key) {
        this.logger.warn(
          `${objectType}: row has no ERP key, skipping — ${JSON.stringify(row).slice(0, 200)}`,
        );
        continue;
      }
      keyed.set(key, row);
    }
    const entries = [...keyed.entries()];

    let changed = 0;
    let fetched = 0;

    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);

      // ONE multi-row upsert per chunk instead of one statement per row — this is
      // what makes a full sweep of thousands of rows finish in seconds rather than
      // minutes. A single per-chunk timestamp keeps change detection exact:
      // changed_at === stamp only for rows inserted or whose hash actually moved.
      const stamp = new Date();
      const params: unknown[] = [objectType, stamp];
      const valueRows: string[] = [];
      let p = 3;
      for (const [key, row] of chunk) {
        valueRows.push(`($1, $${p}, $${p + 1}::jsonb, $${p + 2}, $2, $2, $2)`);
        params.push(key, JSON.stringify(row), RawRepository.hash(row));
        p += 3;
      }

      // Table name is from the RAW_TABLE allowlist (never user input); every value
      // is a bound parameter.
      const results = await this.prisma.$queryRawUnsafe<{ changed: boolean }[]>(
        `
        INSERT INTO erp_raw.${t}
          (object_type, erp_key, payload, content_hash,
           first_seen_at, last_seen_at, changed_at)
        VALUES ${valueRows.join(', ')}
        ON CONFLICT (object_type, erp_key) DO UPDATE SET
          last_seen_at = $2,
          payload      = EXCLUDED.payload,
          content_hash = EXCLUDED.content_hash,
          changed_at = CASE
            WHEN ${t}.content_hash IS DISTINCT FROM EXCLUDED.content_hash
            THEN $2 ELSE ${t}.changed_at END,
          projected_at = CASE
            WHEN ${t}.content_hash IS DISTINCT FROM EXCLUDED.content_hash
            THEN NULL ELSE ${t}.projected_at END,
          project_error = CASE
            WHEN ${t}.content_hash IS DISTINCT FROM EXCLUDED.content_hash
            THEN NULL ELSE ${t}.project_error END
        RETURNING (changed_at = $2) AS changed
        `,
        ...params,
      );

      fetched += results.length;
      changed += results.filter((r) => r.changed).length;
    }

    return { fetched, changed };
  }

  /** Rows the ERP has changed that `public.*` hasn't caught up with yet. */
  async pendingProjection(
    objectType: ErpObjectType,
    limit = 500,
  ): Promise<PendingRecord[]> {
    const t = this.table(objectType);
    return this.prisma.$queryRawUnsafe<PendingRecord[]>(
      `
      SELECT id, erp_key, payload
      FROM erp_raw.${t}
      WHERE projected_at IS NULL
      ORDER BY changed_at ASC
      LIMIT $1
      `,
      limit,
    );
  }

  async markProjected(objectType: ErpObjectType, ids: bigint[]): Promise<void> {
    if (ids.length === 0) return;
    const t = this.table(objectType);
    // ids come from our own pendingProjection rows (BigInt), so joining them is
    // numeric-only and injection-safe.
    await this.prisma.$executeRawUnsafe(
      `UPDATE erp_raw.${t} SET projected_at = now(), project_error = NULL
       WHERE id IN (${ids.map((id) => id.toString()).join(',')})`,
    );
  }

  /**
   * Record why a row could not be projected — and leave projected_at NULL so it
   * is retried next cycle. An unmappable row must stay visible, not vanish.
   */
  async markProjectFailed(
    objectType: ErpObjectType,
    id: bigint,
    error: string,
  ): Promise<void> {
    const t = this.table(objectType);
    await this.prisma.$executeRawUnsafe(
      `UPDATE erp_raw.${t} SET project_error = $1 WHERE id = ${id.toString()}`,
      error,
    );
  }

  // ─── Customer identity mapping ───────────────────────────────────────────
  // Sales orders reference CUSTOMER_ID (Guid); public.Customer.erpId holds
  // CUSTOMER_CODE. Without this bridge an order cannot find its customer.

  async linkCustomer(guid: string, code: string): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO erp_raw.customer_link (erp_customer_guid, erp_customer_code, updated_at)
      VALUES (${guid}, ${code}, now())
      ON CONFLICT (erp_customer_guid) DO UPDATE
        SET erp_customer_code = EXCLUDED.erp_customer_code, updated_at = now()
    `;
  }

  /** CUSTOMER_ID (Guid) → CUSTOMER_CODE, or null if we've never seen the Guid. */
  async resolveCustomerCode(guid: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ erp_customer_code: string }[]>`
      SELECT erp_customer_code FROM erp_raw.customer_link
      WHERE erp_customer_guid = ${guid}
    `;
    return rows[0]?.erp_customer_code ?? null;
  }

  // ─── Sync run bookkeeping ────────────────────────────────────────────────

  async startRun(job: string): Promise<bigint> {
    const rows = await this.prisma.$queryRaw<{ id: bigint }[]>`
      INSERT INTO erp_raw.sync_run (job, status) VALUES (${job}, 'RUNNING')
      RETURNING id
    `;
    return rows[0].id;
  }

  async finishRun(
    id: bigint,
    stats: {
      status: 'SUCCESS' | 'FAILED';
      fetched?: number;
      changed?: number;
      projected?: number;
      skipped?: number;
      error?: string;
    },
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE erp_raw.sync_run SET
        status         = ${stats.status},
        finished_at    = now(),
        rows_fetched   = ${stats.fetched ?? 0},
        rows_changed   = ${stats.changed ?? 0},
        rows_projected = ${stats.projected ?? 0},
        rows_skipped   = ${stats.skipped ?? 0},
        error          = ${stats.error ?? null}
      WHERE id = ${id}
    `;
  }
}

/** Recursively key-sorted JSON, so hashing is independent of field order. */
function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`);

  return `{${entries.join(',')}}`;
}
