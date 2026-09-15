import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type ErpObjectType =
  | 'CUSTOMER'
  | 'CUSTOMER_CREDIT'
  | 'CUSTOMER_CREDIT_LINE'
  | 'SALES_ORDER'
  | 'SALES_DELIVERY'
  | 'SALES_RETURN'
  | 'COLLECTION'
  | 'AR_REFUND'
  | 'OTHER_RECEIVABLE'
  | 'AR_TRANSFER';

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
  CUSTOMER_CREDIT_LINE: 'raw_customer_credit_line',
  SALES_ORDER: 'raw_sales_order',
  SALES_DELIVERY: 'raw_sales_delivery',
  SALES_RETURN: 'raw_sales_return',
  COLLECTION: 'raw_collection',
  AR_REFUND: 'raw_ar_refund',
  OTHER_RECEIVABLE: 'raw_other_receivable',
  AR_TRANSFER: 'raw_ar_transfer',
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

  /**
   * Every DB call in this repository goes through here.
   *
   * The managed Postgres drops all connections at once (a restart, a backup, an
   * admin `pg_terminate_backend`), and previously only 2 of ~18 call sites were
   * protected — so a single reset failed all eight ingest jobs plus the lock
   * acquire/release in the same second. PrismaService.withRetry reconnects
   * before each attempt, which is what actually recovers a dead pool.
   */
  private async withRetry<T>(op: () => Promise<T>, label: string): Promise<T> {
    return this.prisma.withRetry(op, label);
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
   * Fields the ERP adds that describe the RESPONSE, not the record.
   *
   * `DCMS_ROWNUM` is the row's position in the result set. It appears only when
   * the query is ordered, and it shifts whenever anything is inserted or removed
   * ahead of a row — so storing it makes every row look "changed" on the next
   * sweep even when nothing about the record moved. That defeats the content-hash
   * check this whole design rests on: a steady-state sweep rewrote all ~1M
   * sales-order rows instead of writing nothing, which is a large part of what
   * filled the database disk.
   *
   * Stripped before both hashing and storage, so the payload holds the record and
   * nothing about how it happened to be paged.
   */
  private static readonly RESPONSE_ARTIFACTS = ['DCMS_ROWNUM'] as const;

  static stripArtifacts(row: Record<string, unknown>): Record<string, unknown> {
    let copy: Record<string, unknown> | null = null;
    for (const field of RawRepository.RESPONSE_ARTIFACTS) {
      if (field in row) {
        copy ??= { ...row };
        delete copy[field];
      }
    }
    return copy ?? row;
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
    for (const incoming of rows) {
      // Drop response-only fields BEFORE keying/hashing (see stripArtifacts).
      const row = RawRepository.stripArtifacts(incoming);
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

      // ONE multi-row upsert per chunk instead of one statement per row.
      const stamp = new Date();
      const params: unknown[] = [objectType, stamp];
      const valueRows: string[] = [];
      let p = 3;
      for (const [key, row] of chunk) {
        valueRows.push(`($1, $${p}, $${p + 1}::jsonb, $${p + 2}, $2, $2, $2)`);
        params.push(key, JSON.stringify(row), RawRepository.hash(row));
        p += 3;
      }

      // The WHERE on DO UPDATE is the disk-saver: when a row's content hash hasn't
      // changed, the update is a NO-OP — no new row version, no WAL, no dead tuple.
      // A steady-state sweep of unchanged rows therefore writes ~nothing, instead
      // of rewriting all ~880k rows every cycle (which is what filled the disk).
      // Because the update only fires when the hash differs, changed_at / projected_at
      // / project_error can be set unconditionally — no CASE needed.
      //
      // RETURNING therefore yields exactly the rows that were inserted or changed,
      // so results.length == "changed". `fetched` is the count we sent.
      const results = await this.withRetry(
        () =>
          this.prisma.$queryRawUnsafe<{ erp_key: string }[]>(
            `
        INSERT INTO erp_raw.${t}
          (object_type, erp_key, payload, content_hash,
           first_seen_at, last_seen_at, changed_at)
        VALUES ${valueRows.join(', ')}
        ON CONFLICT (object_type, erp_key) DO UPDATE SET
          last_seen_at  = $2,
          payload       = EXCLUDED.payload,
          content_hash  = EXCLUDED.content_hash,
          changed_at    = $2,
          projected_at  = NULL,
          project_error = NULL
        WHERE ${t}.content_hash IS DISTINCT FROM EXCLUDED.content_hash
        RETURNING erp_key
        `,
            ...params,
          ),
        `upsert erp_raw.${t}`,
      );

      fetched += chunk.length;
      changed += results.length;
    }

    return { fetched, changed };
  }

  /**
   * A page of pending rows, cursor-based (id > afterId, ORDER BY id).
   *
   * Cursor paging (not OFFSET, not "pending until empty") is what lets a caller
   * DRAIN the whole backlog in one run without looping forever: a row that gets
   * skipped stays pending, but the cursor still advances past it, so the same
   * un-projectable rows are not re-fetched within the same drain. They are simply
   * retried on the NEXT run.
   */
  // ─── Ingest resume cursor ────────────────────────────────────────────────
  // The ERP has no delta support, so an interrupted sweep would otherwise restart
  // from page 1 every time and — if the process keeps restarting before the sweep
  // finishes — never complete. We persist the last fully-ingested page per job so
  // a restart RESUMES. The cursor is cleared when a sweep finishes cleanly, so the
  // next cycle starts fresh from page 1 (a full re-sweep to catch early-page changes).

  async getIngestPage(job: string): Promise<number> {
    const rows = await this.withRetry(
      () => this.prisma.$queryRaw<{ cursor_value: string | null }[]>`
        SELECT cursor_value FROM erp_raw.sync_cursor WHERE job = ${job}
      `,
      `getIngestPage(${job})`,
    );
    const v = rows[0]?.cursor_value;
    const n = v ? Number(v) : 0;
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  async setIngestPage(job: string, page: number): Promise<void> {
    await this.withRetry(
      () => this.prisma.$executeRaw`
        INSERT INTO erp_raw.sync_cursor (job, cursor_value, updated_at)
        VALUES (${job}, ${String(page)}, now())
        ON CONFLICT (job) DO UPDATE SET cursor_value = ${String(page)}, updated_at = now()
      `,
      `setIngestPage(${job})`,
    );
  }

  /**
   * Incremental watermark — stored as the ERP's OWN timestamp text, verbatim.
   *
   * ⚠️ Deliberately a string, not a Date. An earlier version stamped our own
   * clock (UTC) and compared it against the ERP's LastModifiedDate, which is in
   * the ERP's local time. Whenever our clock ran ahead of theirs, the filter
   * asked for "changes since a moment that has not happened yet on their side"
   * and quietly returned nothing — updates would be missed permanently, with no
   * error anywhere. Keeping the ERP's own value means the comparison happens
   * entirely in the ERP's clock space and no conversion can go wrong.
   *
   * Returns null when the job has never completed a sweep, which forces a full
   * one — exactly what we want on a first run.
   */
  async getWatermark(job: string): Promise<string | null> {
    const rows = await this.withRetry(
      () => this.prisma.$queryRaw<{ cursor_value: string | null }[]>`
        SELECT cursor_value FROM erp_raw.sync_cursor WHERE job = ${'watermark:' + job}
      `,
      `getWatermark(${job})`,
    );
    return rows[0]?.cursor_value ?? null;
  }

  /**
   * Record the watermark. Call ONLY after a sweep finished without gaps, and pass
   * the HIGHEST LastModifiedDate actually seen in the data — not the clock time.
   */
  async setWatermark(job: string, erpTimestamp: string): Promise<void> {
    await this.withRetry(
      () => this.prisma.$executeRaw`
        INSERT INTO erp_raw.sync_cursor (job, cursor_value, updated_at)
        VALUES (${'watermark:' + job}, ${erpTimestamp}, now())
        ON CONFLICT (job) DO UPDATE SET cursor_value = ${erpTimestamp}, updated_at = now()
      `,
      `setWatermark(${job})`,
    );
  }

  /** When the watermark was last moved — used to force a periodic full re-sweep. */
  async watermarkUpdatedAt(job: string): Promise<Date | null> {
    const rows = await this.withRetry(
      () => this.prisma.$queryRaw<{ updated_at: Date }[]>`
        SELECT updated_at FROM erp_raw.sync_cursor WHERE job = ${'watermark:full:' + job}
      `,
      `watermarkUpdatedAt(${job})`,
    );
    return rows[0]?.updated_at ?? null;
  }

  /** Stamp when this job last completed a FULL (unfiltered) sweep. */
  async markFullSweep(job: string): Promise<void> {
    await this.withRetry(
      () => this.prisma.$executeRaw`
        INSERT INTO erp_raw.sync_cursor (job, cursor_value, updated_at)
        VALUES (${'watermark:full:' + job}, ${new Date().toISOString()}, now())
        ON CONFLICT (job) DO UPDATE SET cursor_value = ${new Date().toISOString()}, updated_at = now()
      `,
      `markFullSweep(${job})`,
    );
  }

  // ─── Full-sweep reconciliation ───────────────────────────────────────────
  // A raw row is keyed on the ERP's identifier, but for some objects that
  // identifier is not stable: customer_credit's key includes EFFECTIVE_DATE, and
  // when the ERP edits that field in place the record arrives as a NEW row while
  // the old one stays behind forever. No stable key exists for that view, so a
  // full sweep instead records what it saw and deletes what it did not.

  /**
   * Drop key sets abandoned by earlier sweeps of this object.
   *
   * A sweep that is killed mid-flight (pm2 restart, watchdog exit, crash) never
   * reaches its cleanup, and its keys would sit here forever — growing without
   * bound and, worse, mixing into nothing useful. Clearing at the START of a
   * sweep is the reliable moment: it needs no shutdown hook to fire.
   */
  async clearStaleSeen(objectType: ErpObjectType, keepSweepId: string): Promise<void> {
    await this.withRetry(
      () => this.prisma.$executeRaw`
        DELETE FROM erp_raw.sweep_seen
        WHERE object_type = ${objectType} AND sweep_id <> ${keepSweepId}
      `,
      `clearStaleSeen(${objectType})`,
    );
  }

  /** Remember the keys returned by one page of a full sweep. */
  async recordSeen(objectType: ErpObjectType, sweepId: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const t = this.table(objectType); // validates the object type
    void t;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK);
      const params: unknown[] = [sweepId, objectType];
      const values = chunk.map((_, n) => `($1, $2, $${n + 3})`).join(', ');
      params.push(...chunk);
      await this.withRetry(
        () =>
          this.prisma.$executeRawUnsafe(
            `INSERT INTO erp_raw.sweep_seen (sweep_id, object_type, erp_key)
             VALUES ${values} ON CONFLICT DO NOTHING`,
            ...params,
          ),
        `recordSeen(${objectType})`,
      );
    }
  }

  /** How many keys a sweep has recorded so far — the safety check before deleting. */
  async seenCount(sweepId: string): Promise<number> {
    const rows = await this.withRetry(
      () => this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM erp_raw.sweep_seen WHERE sweep_id = ${sweepId}
      `,
      'seenCount',
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Delete rows the completed full sweep never returned — ERP deletions, and the
   * ghosts left behind when a record's key fields were edited.
   *
   * ⚠️ Only ever call this after a sweep that ran to the END. A paused or failed
   * sweep has an incomplete key set, and deleting against it would wipe the
   * object. The caller enforces that; the count check here is the second line of
   * defence.
   */
  async deleteUnseen(objectType: ErpObjectType, sweepId: string): Promise<number> {
    const t = this.table(objectType);
    const deleted = await this.withRetry(
      () =>
        this.prisma.$executeRawUnsafe(
          `DELETE FROM erp_raw.${t} r
           WHERE NOT EXISTS (
             SELECT 1 FROM erp_raw.sweep_seen s
             WHERE s.sweep_id = $1 AND s.erp_key = r.erp_key
           )`,
          sweepId,
        ),
      `deleteUnseen(${objectType})`,
    );
    return deleted;
  }

  /** Drop a sweep's recorded keys — always, whether it completed or not. */
  async clearSeen(sweepId: string): Promise<void> {
    await this.withRetry(
      () => this.prisma.$executeRaw`DELETE FROM erp_raw.sweep_seen WHERE sweep_id = ${sweepId}`,
      'clearSeen',
    );
  }

  /** Rows currently held for an object — used to sanity-check a reconciliation. */
  async rowCount(objectType: ErpObjectType): Promise<number> {
    const t = this.table(objectType);
    const rows = await this.withRetry(
      () => this.prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM erp_raw.${t}`),
      `rowCount(${objectType})`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Forget the watermark, forcing the next sweep to be a full one. */
  async clearWatermark(job: string): Promise<void> {
    await this.withRetry(
      () => this.prisma.$executeRaw`DELETE FROM erp_raw.sync_cursor WHERE job = ${'watermark:' + job}`,
      `clearWatermark(${job})`,
    );
  }

  async clearIngestPage(job: string): Promise<void> {
    await this.withRetry(
      () => this.prisma.$executeRaw`DELETE FROM erp_raw.sync_cursor WHERE job = ${job}`,
      `clearIngestPage(${job})`,
    );
  }

  async pendingProjection(
    objectType: ErpObjectType,
    afterId: bigint,
    limit: number,
  ): Promise<PendingRecord[]> {
    const t = this.table(objectType);
    return this.withRetry(
    () => this.prisma.$queryRawUnsafe<PendingRecord[]>(
        `
        SELECT id, erp_key, payload
        FROM erp_raw.${t}
        WHERE projected_at IS NULL AND id > $1
        ORDER BY id ASC
        LIMIT $2
        `,
        afterId,
        limit,
      ),
    'pendingProjection',
);
  }

  /**
   * Pending transaction rows whose customer is an ACTIVE app user (has a
   * password — i.e. onboarded). This is the "transactions on-demand" scope: we
   * only project a customer's orders/payments once they actually use the app, and
   * the rest stay queued and project themselves the moment that customer onboards.
   *
   * The customer join differs by object: sales orders reference CUSTOMER_ID (a
   * Guid, resolved via customer_link); collections carry CUSTOMER_CODE directly.
   */
  async pendingProjectionActive(
    objectType: 'SALES_ORDER' | 'COLLECTION',
    afterId: bigint,
    limit: number,
  ): Promise<PendingRecord[]> {
    if (objectType === 'SALES_ORDER') {
      return this.withRetry(
    () => this.prisma.$queryRawUnsafe<PendingRecord[]>(
          `
          SELECT r.id, r.erp_key, r.payload
          FROM erp_raw.raw_sales_order r
          JOIN erp_raw.customer_link cl ON cl.erp_customer_guid = r.payload->>'CUSTOMER_ID'
          JOIN public."Customer" c ON c."erpId" = cl.erp_customer_code AND c.password IS NOT NULL
          WHERE r.projected_at IS NULL AND r.id > $1
          ORDER BY r.id ASC
          LIMIT $2
          `,
          afterId,
          limit,
        ),
    'pendingProjection',
);
    }
    return this.withRetry(
    () => this.prisma.$queryRawUnsafe<PendingRecord[]>(
        `
        SELECT r.id, r.erp_key, r.payload
        FROM erp_raw.raw_collection r
        JOIN public."Customer" c ON c."erpId" = r.payload->>'CUSTOMER_CODE' AND c.password IS NOT NULL
        WHERE r.projected_at IS NULL AND r.id > $1
        ORDER BY r.id ASC
        LIMIT $2
        `,
        afterId,
        limit,
      ),
    'pendingProjection',
);
  }

  /**
   * Bulk-project every ACTIVE customer's unprojected sales orders into
   * public."Purchase" in a single set-based statement, and mark the raw rows
   * projected. This replaces the per-row loop that was too slow to finish within
   * the lock lease. Only orders whose ApproveStatus is in `statusMap` and that
   * have a usable date are projected; the rest stay queued.
   *
   * ⚠️ A raw sales-order row is ONE ORDER LINE, not one order (see
   * SalesOrderIngestJob) — a multi-line order is N rows repeating the same
   * header. Two consequences, both handled by the `hdr` CTE below:
   *
   *  - Purchase.erpId comes from `payload->>'DOC_NO'`, not from `erp_key`
   *    (which is now the detail-line id). Otherwise each line would become its
   *    own Purchase.
   *  - The lines are reduced to one representative row per DOC_NO. Without that,
   *    a multi-line order would hit the same conflict target twice in one
   *    statement, which Postgres rejects outright ("ON CONFLICT DO UPDATE command
   *    cannot affect row a second time").
   *
   * The header totals (QTY_TOTAL, AMT_UNINCLUDE_TAX_OC, TAX_OC) are repeated
   * verbatim on every line, so they are taken from that single representative
   * row and deliberately NOT summed — summing would multiply each by the number
   * of lines.
   */
  async bulkProjectPurchases(
    statusMap: Record<string, string>,
  ): Promise<{ projected: number }> {
    const keys = Object.keys(statusMap);
    if (keys.length === 0) return { projected: 0 };
    const esc = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const inList = keys.map(esc).join(',');
    const caseSql = keys
      .map((k) => `WHEN ${esc(k)} THEN ${esc(statusMap[k])}`)
      .join(' ');

    const rows = await this.withRetry(
    () => this.prisma.$queryRawUnsafe<{ n: number }[]>(`
        WITH proj AS (
          UPDATE erp_raw.raw_sales_order r
          SET projected_at = now(), project_error = NULL
          FROM erp_raw.customer_link cl, public."Customer" c
          WHERE cl.erp_customer_guid = r.payload->>'CUSTOMER_ID'
            AND c."erpId" = cl.erp_customer_code AND c.password IS NOT NULL
            AND r.projected_at IS NULL
            AND r.payload->>'ApproveStatus' IN (${inList})
            AND NULLIF(r.payload->>'ORDER_DATE','') IS NOT NULL
            AND NULLIF(r.payload->>'DOC_NO','') IS NOT NULL
          RETURNING r.id, r.payload, c.id AS customer_id
        ), hdr AS (
          SELECT DISTINCT ON (payload->>'DOC_NO') id, payload, customer_id
          FROM proj
          ORDER BY payload->>'DOC_NO', id
        ), ins AS (
          INSERT INTO public."Purchase"
            (id,"erpId","customerId","orderDate","totalItems","totalValue",status,"createdAt","updatedAt")
          SELECT gen_random_uuid(), payload->>'DOC_NO', customer_id,
            (payload->>'ORDER_DATE')::timestamp,
            CASE WHEN payload->>'QTY_TOTAL' ~ '^[0-9.]+$' THEN (payload->>'QTY_TOTAL')::numeric::int ELSE 0 END,
            COALESCE(NULLIF(payload->>'AMT_UNINCLUDE_TAX_OC','')::numeric,0)
              + COALESCE(NULLIF(payload->>'TAX_OC','')::numeric,0),
            (CASE payload->>'ApproveStatus' ${caseSql} END)::"OrderStatus",
            now(), now()
          FROM hdr
          ON CONFLICT ("erpId") DO UPDATE SET
            status = EXCLUDED.status, "orderDate" = EXCLUDED."orderDate",
            "totalItems" = EXCLUDED."totalItems", "totalValue" = EXCLUDED."totalValue",
            "updatedAt" = now()
          RETURNING 1
        )
        SELECT count(*)::int AS n FROM ins
      `),
    'bulkProject',
);
    return { projected: Number(rows[0]?.n ?? 0) };
  }

  /**
   * Bulk-project every ACTIVE customer's unprojected collections into
   * public."Payment" in one statement. runningBalance is set to 0 on insert and
   * left untouched on conflict (so any value set elsewhere is preserved).
   */
  async bulkProjectPayments(): Promise<{ projected: number }> {
    const rows = await this.withRetry(
    () => this.prisma.$queryRawUnsafe<{ n: number }[]>(`
        WITH proj AS (
          UPDATE erp_raw.raw_collection r
          SET projected_at = now(), project_error = NULL
          FROM public."Customer" c
          WHERE c."erpId" = r.payload->>'CUSTOMER_CODE' AND c.password IS NOT NULL
            AND r.projected_at IS NULL
            AND NULLIF(r.payload->>'DOC_DATE','') IS NOT NULL
          RETURNING r.erp_key, r.payload, c.id AS customer_id
        ), ins AS (
          INSERT INTO public."Payment"
            (id,"erpId","customerId",date,amount,reference,"runningBalance","createdAt")
          SELECT gen_random_uuid(), erp_key, customer_id,
            (payload->>'DOC_DATE')::timestamp,
            COALESCE(NULLIF(payload->>'COLLECTION_AMT_TC','')::numeric,0), erp_key, 0, now()
          FROM proj
          ON CONFLICT ("erpId") DO UPDATE SET
            amount = EXCLUDED.amount, date = EXCLUDED.date
          RETURNING 1
        )
        SELECT count(*)::int AS n FROM ins
      `),
    'bulkProject',
);
    return { projected: Number(rows[0]?.n ?? 0) };
  }

  /**
   * Refresh ERP-owned fields (name) on customers that ALREADY exist, in one
   * statement. Customer CREATION is not attempted here: the ERP phone is a shared
   * placeholder (thousands of customers share one number), so mass creation is
   * impossible until the ERP supplies real per-customer phones. phone and region
   * are app-owned and never touched. The IS DISTINCT FROM guard skips no-op writes.
   */
  async bulkRefreshCustomers(): Promise<{ updated: number }> {
    const rows = await this.withRetry(
    () => this.prisma.$queryRawUnsafe<{ n: number }[]>(`
        WITH upd AS (
          UPDATE public."Customer" c
          SET name = COALESCE(NULLIF(rc.payload->>'CUSTOMER_FULL_NAME',''),
                              NULLIF(rc.payload->>'CUSTOMER_NAME',''), c.name),
              "updatedAt" = now()
          FROM erp_raw.raw_customer rc
          WHERE rc.erp_key = c."erpId" AND c."erpId" IS NOT NULL
            AND c.name IS DISTINCT FROM COALESCE(NULLIF(rc.payload->>'CUSTOMER_FULL_NAME',''),
                                                 NULLIF(rc.payload->>'CUSTOMER_NAME',''), c.name)
          RETURNING 1
        )
        SELECT count(*)::int AS n FROM upd
      `),
    'bulkProject',
);
    return { updated: Number(rows[0]?.n ?? 0) };
  }

  async markProjected(objectType: ErpObjectType, ids: bigint[]): Promise<void> {
    if (ids.length === 0) return;
    const t = this.table(objectType);
    // ids come from our own pendingProjection rows (BigInt), so joining them is
    // numeric-only and injection-safe.
    await this.withRetry(
      () =>
        this.prisma.$executeRawUnsafe(
          `UPDATE erp_raw.${t} SET projected_at = now(), project_error = NULL
           WHERE id IN (${ids.map((id) => id.toString()).join(',')})`,
        ),
      `markProjected(${t})`,
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
    await this.withRetry(
      () =>
        this.prisma.$executeRawUnsafe(
          `UPDATE erp_raw.${t} SET project_error = $1 WHERE id = ${id.toString()}`,
          error,
        ),
      `markProjectFailed(${t})`,
    );
  }

  // ─── Customer identity mapping ───────────────────────────────────────────
  // Sales orders reference CUSTOMER_ID (Guid); public.Customer.erpId holds
  // CUSTOMER_CODE. Without this bridge an order cannot find its customer.

  async linkCustomer(guid: string, code: string): Promise<void> {
    await this.linkCustomers([{ guid, code }]);
  }

  /**
   * Batched guid→code bridge. One multi-row upsert per chunk instead of one per
   * customer — without this, building the bridge for thousands of customers was
   * the slowest part of a sweep and kept the cycle from ever reaching the later
   * endpoints.
   */
  async linkCustomers(pairs: { guid: string; code: string }[]): Promise<void> {
    // Dedupe by guid so a multi-row ON CONFLICT can't touch the same row twice.
    const byGuid = new Map<string, string>();
    for (const { guid, code } of pairs) {
      if (guid && code) byGuid.set(guid, code);
    }
    const entries = [...byGuid.entries()];

    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      const params: unknown[] = [];
      const values: string[] = [];
      let p = 1;
      for (const [guid, code] of chunk) {
        values.push(`($${p}, $${p + 1}, now())`);
        params.push(guid, code);
        p += 2;
      }
      await this.withRetry(
        () =>
          this.prisma.$executeRawUnsafe(
            `INSERT INTO erp_raw.customer_link (erp_customer_guid, erp_customer_code, updated_at)
         VALUES ${values.join(', ')}
         ON CONFLICT (erp_customer_guid) DO UPDATE
           SET erp_customer_code = EXCLUDED.erp_customer_code, updated_at = now()`,
            ...params,
          ),
        'link customers',
      );
    }
  }

  /** CUSTOMER_ID (Guid) → CUSTOMER_CODE, or null if we've never seen the Guid. */
  async resolveCustomerCode(guid: string): Promise<string | null> {
    const rows = await this.withRetry(
      () => this.prisma.$queryRaw<{ erp_customer_code: string }[]>`
        SELECT erp_customer_code FROM erp_raw.customer_link
        WHERE erp_customer_guid = ${guid}
      `,
      'resolveCustomerCode',
    );
    return rows[0]?.erp_customer_code ?? null;
  }

  // ─── Sync run bookkeeping ────────────────────────────────────────────────

  async startRun(job: string): Promise<bigint> {
    const rows = await this.withRetry(
      () => this.prisma.$queryRaw<{ id: bigint }[]>`
        INSERT INTO erp_raw.sync_run (job, status) VALUES (${job}, 'RUNNING')
        RETURNING id
      `,
      `startRun(${job})`,
    );
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
    await this.withRetry(
      () => this.prisma.$executeRaw`
        UPDATE erp_raw.sync_run SET
          status         = ${stats.status},
          finished_at    = now(),
          rows_fetched   = ${stats.fetched ?? 0},
          rows_changed   = ${stats.changed ?? 0},
          rows_projected = ${stats.projected ?? 0},
          rows_skipped   = ${stats.skipped ?? 0},
          error          = ${stats.error ?? null}
        WHERE id = ${id}
      `,
      'finishRun',
    );
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
