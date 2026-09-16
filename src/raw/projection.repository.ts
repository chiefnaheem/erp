import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VIJU_REGIONS, VijuRegion } from '../sync/erp.mappers';

/**
 * Projection = erp_raw → public.*
 *
 * ─── Why this file exists ───────────────────────────────────────────────────
 *
 * The previous projector was insert-only in the places that mattered and had no
 * memory of its own. Customers were never created (only `name` was refreshed on
 * the handful of rows that already existed), so 1,847 of the 1,851 Viju
 * distributors in the feed never reached the portal at all, and a change to a
 * distributor's phone or region had nowhere to land. Balances were copied from
 * the ERP's CREDIT_PAY, which is credit *consumed* — the opposite sign of what
 * the portal displays.
 *
 * Every projector here is an idempotent upsert keyed on the ERP's own natural
 * key, driven by a changed_at watermark, wrapped in one transaction under a
 * Postgres advisory lock. Running the same window twice changes nothing the
 * second time; killing the process mid-run rolls back cleanly and the next run
 * redoes the work.
 *
 * ─── Column ownership ───────────────────────────────────────────────────────
 *
 * The single most dangerous thing a projector can do is a naive `DO UPDATE SET`
 * that overwrites everything. These columns belong to the APPLICATION and the
 * ERP must never touch them, so they appear in no update clause below:
 *
 *   Customer  email, password, failedLoginAttempts, lockedUntil,
 *             profilePhotoUrl, accountStatus, assignedOfficerId, createdAt
 *   Purchase  status, statusUpdatedAt, createdAt   (see PURCHASE_STATUS below)
 *   Payment   runningBalance, createdAt
 *   Staff     the whole table — admin / regional admin / account officer /
 *             loading officer accounts are provisioned by the backend. Nothing
 *             in this file reads or writes public."Staff".
 *
 * ─── Enum labels ────────────────────────────────────────────────────────────
 *
 * Region and OrderStatus values are written as text and cast with ::"Region" /
 * ::"OrderStatus" in SQL rather than taken from the generated Prisma client.
 * prisma/schema/ in this repo is a stale copy of the main API's schema (it still
 * lists Region.SOUTH_WEST / SOUTH_EAST, which no longer exist in the database,
 * and is missing OrderStatus.LOADED / DISPATCHED / CLOSED and
 * PurchaseItem.itemCode). Casting in SQL makes the database the single source of
 * truth, and turns a stale label into a loud error instead of a silent
 * mis-projection.
 */

export interface ProjectionSelector {
  /** Ignore the watermark and re-scan the entire feed. */
  full: boolean;
}

export interface ProjectionResult {
  /** Raw rows the run considered. */
  fetched: number;
  /** Rows written into public.* (inserted or updated). */
  projected: number;
  /** Rows deliberately refused — quarantined, not silently dropped. */
  skipped: number;
  /** True when the advisory lock was already held, so this run did nothing. */
  lockBusy?: boolean;
  /** Free-form notes surfaced in the job log. */
  notes: string[];
}

const EMPTY = (): ProjectionResult => ({
  fetched: 0,
  projected: 0,
  skipped: 0,
  notes: [],
});

/**
 * Advisory-lock keys. Two-int form, so the classid (871) namespaces them away
 * from anything the main API might take.
 *
 * A lease row (erp_raw.sync_lock) already stops two SCHEDULERS overlapping; this
 * is the belt-and-braces guard the lease cannot give, because it is held by the
 * transaction itself. It is released the instant the transaction ends — commit,
 * rollback, or the backend dying — so a killed worker cannot leave it stuck.
 */
const LOCK_CLASS = 871;
const LOCK_KEY: Record<string, number> = {
  'project:customer': 1,
  'project:purchase': 2,
  'project:payment': 3,
};

// ─── SQL fragment helpers ────────────────────────────────────────────────────
//
// ERP payloads are JSONB and every scalar arrives as text. A bare `::numeric` or
// `::timestamp` on a blank or malformed value aborts the whole statement, which
// is exactly how one bad row used to take out a batch. These guard the cast and
// fall back instead.

/** Numeric value of a JSON field, 0 when blank/missing/not a number. */
const num = (expr: string) =>
  `(CASE WHEN btrim(coalesce(${expr}, '')) ~ '^-?[0-9]+(\\.[0-9]+)?$'` +
  ` THEN btrim(${expr})::numeric ELSE 0 END)`;

/**
 * Timestamp value of a JSON field, NULL when blank/missing/malformed.
 *
 * ERP dates arrive as naive text ("2026-07-01 00:00:00") and the app's date
 * columns are `timestamp without time zone`, so this is a straight parse with no
 * shift — the ERP's wall-clock value is stored verbatim. See CONTRACT.md: the
 * ERP declares +8 while Viju runs at +1, and correcting for that is a decision
 * the ERP team still owes us. Guessing an offset would be worse than keeping the
 * value the ERP sent.
 */
const ts = (expr: string) =>
  `(CASE WHEN btrim(coalesce(${expr}, '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'` +
  ` THEN btrim(${expr})::timestamp ELSE NULL END)`;

/** A single-quoted SQL literal. Only ever used on values we generated ourselves. */
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

@Injectable()
export class ProjectionRepository {
  private readonly logger = new Logger(ProjectionRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Watermarks ───────────────────────────────────────────────────────────
  //
  // A run selects rows newer than the job's watermark and advances it only when
  // the transaction COMMITS. A crashed run therefore costs nothing but a repeat.
  //
  // NO WATERMARK ROW = FULL RE-PROJECTION. That is deliberate: the first run
  // after this change has no row yet, so it backfills the entire feed without
  // anyone having to remember to ask. It is also the documented way to force a
  // re-run later:
  //
  //   DELETE FROM erp_raw.projection_watermark WHERE job = 'project:customer';
  //
  // ...or set ERP_PROJECT_FULL=true to ignore the watermark on every run.

  async getWatermark(job: string): Promise<Date | null> {
    const rows = await this.prisma.withRetry(
      () => this.prisma.$queryRaw<{ watermark: Date }[]>`
        SELECT watermark FROM erp_raw.projection_watermark WHERE job = ${job}
      `,
      `getWatermark(${job})`,
    );
    return rows[0]?.watermark ?? null;
  }

  async clearWatermark(job: string): Promise<void> {
    await this.prisma.withRetry(
      () => this.prisma
        .$executeRaw`DELETE FROM erp_raw.projection_watermark WHERE job = ${job}`,
      `clearWatermark(${job})`,
    );
  }

  /** Open quarantine entries per reason, for the run log and for /health. */
  async quarantineSummary(
    job: string,
  ): Promise<{ reason: string; count: number }[]> {
    const rows = await this.prisma.withRetry(
      () => this.prisma.$queryRaw<{ reason: string; count: bigint }[]>`
        SELECT reason, count(*) AS count
        FROM erp_raw.projection_quarantine
        WHERE job = ${job} AND resolved_at IS NULL
        GROUP BY reason
        ORDER BY count DESC
      `,
      `quarantineSummary(${job})`,
    );
    return rows.map((r) => ({ reason: r.reason, count: Number(r.count) }));
  }

  // ─── Shared transaction wrapper ───────────────────────────────────────────

  /**
   * Run one projection pass: advisory lock, generous statement timeout, one
   * transaction.
   *
   * The lock is `try` rather than blocking — if another instance (or an
   * overlapping schedule) is already projecting this entity, this run stands
   * down immediately instead of queueing behind it and then redoing its work.
   */
  private async pass(
    job: string,
    statementTimeoutMs: number,
    txTimeoutMs: number,
    work: (tx: TxClient, wm: Date | null) => Promise<ProjectionResult>,
    workMemMb = 64,
  ): Promise<ProjectionResult> {
    const watermark = await this.getWatermark(job);
    const lockKey = LOCK_KEY[job];
    if (lockKey === undefined) throw new Error(`no advisory lock key for ${job}`);

    return this.prisma.withRetry(
      () =>
        this.prisma.$transaction(
          async (tx) => {
            const locked = await tx.$queryRawUnsafe<{ ok: boolean }[]>(
              'SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS ok',
              LOCK_CLASS,
              lockKey,
            );
            if (!locked[0]?.ok) {
              return { ...EMPTY(), lockBusy: true };
            }

            // The first backfill run touches the whole customer set, so the
            // default (which on this server is "no limit", but on a pooler may
            // not be) is not something to rely on.
            await tx.$executeRawUnsafe(
              `SET LOCAL statement_timeout = ${Math.floor(statementTimeoutMs)}`,
            );

            // Do the sorting and hashing in MEMORY, not in temp files.
            //
            // The server's work_mem is 4MB, so every aggregate of any size spills
            // to disk — and on 2026-09-16 the disk was full, which is a hard
            // failure (53100) rather than a slow one. Each run's working set is
            // capped (ERP_PROJECT_MAX_ROWS_PER_RUN), so a session-local work_mem
            // holds it comfortably and the projection stops depending on free
            // disk at all. SET LOCAL, so it dies with the transaction and does
            // not change the setting for anything else on the server.
            await tx.$executeRawUnsafe(
              `SET LOCAL work_mem = '${Math.floor(workMemMb)}MB'`,
            );

            // Tell the planner the storage is an SSD.
            //
            // The default random_page_cost of 4 describes a spinning disk, and on
            // this data it is the difference between an index scan and a full
            // read of a 3GB table. Measured on the purchase job's line pass:
            // 48.6s with the default, 2.0s with this — same rows, same result.
            // SET LOCAL, so it applies to this transaction only.
            await tx.$executeRawUnsafe(`SET LOCAL random_page_cost = 1.1`);

            return work(tx as unknown as TxClient, watermark);
          },
          { timeout: txTimeoutMs, maxWait: 30_000 },
        ),
      `projection ${job}`,
    );
  }

  /**
   * The row selector.
   *
   * `projected_at IS NULL OR changed_at > watermark` — BOTH, not just the
   * watermark. The ingest resets projected_at whenever a payload hash moves, and
   * a row that could not be projected yet (a transaction whose customer has not
   * onboarded, a row that was quarantined) keeps projected_at NULL so it heals
   * itself the moment the blocker clears. A watermark alone would strand every
   * one of those permanently.
   */
  private selector(alias: string, watermark: Date | null, full: boolean): string {
    if (full || !watermark) return 'TRUE';
    return `(${alias}.projected_at IS NULL OR ${alias}.changed_at > ${lit(
      watermark.toISOString(),
    )}::timestamptz)`;
  }

  private async advanceWatermark(
    tx: TxClient,
    job: string,
    projected: number,
    sources: { table: string; predicate: string }[],
  ): Promise<void> {
    // GREATEST over every feed the job consumed, so a job driven by two tables
    // (customers + their credit records) cannot advance past one and strand the
    // other. NULL means "nothing was scanned" — leave the watermark alone.
    const parts = sources.map(
      (s) => `(SELECT max(changed_at) FROM erp_raw.${s.table} WHERE ${s.predicate})`,
    );
    const rows = await tx.$queryRawUnsafe<{ wm: Date | null }[]>(
      `SELECT GREATEST(${parts.join(', ')}) AS wm`,
    );
    const wm = rows[0]?.wm;
    if (!wm) return;

    await tx.$executeRawUnsafe(
      `INSERT INTO erp_raw.projection_watermark (job, watermark, rows_projected, updated_at)
       VALUES ($1, $2::timestamptz, $3::bigint, now())
       ON CONFLICT (job) DO UPDATE SET
         watermark      = GREATEST(erp_raw.projection_watermark.watermark, EXCLUDED.watermark),
         rows_projected = erp_raw.projection_watermark.rows_projected + EXCLUDED.rows_projected,
         updated_at     = now()`,
      job,
      wm.toISOString(),
      projected,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CUSTOMER
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * erp_raw.raw_customer (+ raw_customer_credit) → public."Customer",
   * upserted on "erpId" ← CUSTOMER_CODE.
   *
   * Three things this fixes, all of them field-level bugs the old set-based
   * refresh could not express:
   *
   *  1. CREATION. The feed's 1,851 Viju distributors are now projected, not just
   *     the four that happened to exist already.
   *
   *  2. REGION comes from BP_CLUSTER_CODE (1–5), not the blank `Region` field.
   *     Anything outside 1–5 belongs to another tenant on the same ERP and is
   *     quarantined — never defaulted to a region.
   *
   *  3. outstandingBalance = CREDIT_AMT + CREDIT_AMT1 − CREDIT_PAY, computed in
   *     `numeric` and unrounded, from the NEWEST credit record per customer. The
   *     old projector copied CREDIT_PAY straight across, which is credit
   *     *consumed* and therefore inverted the sign for every customer holding
   *     credit. Positive now means funds available, which is what the portal
   *     assumes. A customer with no credit record keeps whatever balance they
   *     have — never zeroed.
   */
  async projectCustomers(opts: {
    full: boolean;
    clusterRegionMap: Record<string, VijuRegion>;
    updatePhone: boolean;
    syntheticPhone: boolean;
    /** Regex a normalised phone must match to be written. */
    phonePattern: string;
    statementTimeoutMs: number;
    txTimeoutMs: number;
  }): Promise<ProjectionResult> {
    const JOB = 'project:customer';

    /**
     * The placeholder identity, used only when ERP_CUSTOMER_SYNTHETIC_PHONE is
     * on. See the note at the phone-safety step below for why this exists and
     * why it is deliberately NOT a phone number.
     */
    const placeholder = opts.syntheticPhone ? `('erp:' || c.erp_id)` : `NULL::text`;

    // Built from a map whose values were validated against VIJU_REGIONS, so the
    // only strings that reach the ::"Region" cast are real enum labels.
    const whens = Object.entries(opts.clusterRegionMap)
      .filter(([code, region]) =>
        code && (VIJU_REGIONS as readonly string[]).includes(region),
      )
      .map(([code, region]) => `WHEN ${lit(code)} THEN ${lit(region)}`);
    // An empty map would leave `CASE x ELSE NULL END`, which is a Postgres
    // syntax error rather than a no-op — and every customer would be quarantined
    // anyway. Refuse the run instead of emitting broken SQL.
    if (whens.length === 0) {
      throw new Error(
        'no BP_CLUSTER_CODE → Region mappings configured; check ERP_CLUSTER_REGION_MAP',
      );
    }
    const regionCase =
      `CASE btrim(coalesce(s.payload->>'BP_CLUSTER_CODE', '')) ` +
      whens.join(' ') +
      ' ELSE NULL END';

    return this.pass(
      JOB,
      opts.statementTimeoutMs,
      opts.txTimeoutMs,
      async (tx, wm) => {
        const notes: string[] = [];
        const custSel = this.selector('r', wm, opts.full);
        const creditSel = this.selector('c', wm, opts.full);

        // ── 1. Candidates ───────────────────────────────────────────────────
        //
        // A customer is a candidate when its OWN row moved, or when its CREDIT
        // record moved. Without the second half a balance change would never
        // reach the app — the customer row itself is untouched by a credit
        // update, which is precisely why balances looked frozen.
        await tx.$executeRawUnsafe(`
          CREATE TEMP TABLE erp_proj_customer ON COMMIT DROP AS
          WITH src AS (
            SELECT r.id AS raw_id, r.erp_key AS erp_id, r.changed_at, r.payload,
                   regexp_replace(coalesce(r.payload->>'PhoneNumber', ''), '[^0-9]', '', 'g') AS digits
            FROM erp_raw.raw_customer r
            WHERE NULLIF(btrim(coalesce(r.erp_key, '')), '') IS NOT NULL
              AND (
                ${custSel}
                OR EXISTS (
                  SELECT 1 FROM erp_raw.raw_customer_credit c
                  WHERE c.payload->>'CUSTOMER_CODE' = r.erp_key AND ${creditSel}
                )
              )
          ), credit AS (
            SELECT DISTINCT ON (c.payload->>'CUSTOMER_CODE')
                   c.payload->>'CUSTOMER_CODE' AS code,
                   (${num("c.payload->>'CREDIT_AMT'")}
                  + ${num("c.payload->>'CREDIT_AMT1'")}
                  - ${num("c.payload->>'CREDIT_PAY'")}) AS balance
            FROM erp_raw.raw_customer_credit c
            WHERE NULLIF(btrim(coalesce(c.payload->>'CUSTOMER_CODE', '')), '') IS NOT NULL
              AND c.payload->>'CUSTOMER_CODE' IN (SELECT erp_id FROM src)
              -- Ignore credit records no longer in force. The ERP gives each record a
              -- validity window, and an expired one says nothing about what the customer
              -- owes today. Without this we published balances from credit lines that
              -- ended long ago: customer 10110003 showed 10,125,600 from a record that
              -- expired 2026-09-05, and 10110270 from one that expired in 2023.
              AND (
                NULLIF(btrim(coalesce(c.payload->>'INEFFECTIVE_DATE', '')), '') IS NULL
                OR c.payload->>'INEFFECTIVE_DATE' = '0001-01-01 00:00:00'
                OR ${ts("c.payload->>'INEFFECTIVE_DATE'")} >= now()
              )
              AND (
                NULLIF(btrim(coalesce(c.payload->>'EFFECTIVE_DATE', '')), '') IS NULL
                OR c.payload->>'EFFECTIVE_DATE' = '0001-01-01 00:00:00'
                OR ${ts("c.payload->>'EFFECTIVE_DATE'")} <= now()
              )
            ORDER BY c.payload->>'CUSTOMER_CODE',
                     ${ts("c.payload->>'EFFECTIVE_DATE'")} DESC NULLS LAST,
                     c.id DESC
          )
          SELECT
            s.raw_id,
            s.erp_id,
            s.changed_at,
            NULLIF(btrim(coalesce(s.payload->>'CUSTOMER_FULL_NAME', '')), '') AS name_full,
            NULLIF(btrim(coalesce(s.payload->>'CUSTOMER_NAME', '')), '')      AS name_alt,
            btrim(coalesce(s.payload->>'BP_CLUSTER_CODE', ''))                AS cluster_code,
            (${regionCase})::text                                             AS region,
            -- Canonical Nigerian E.164, then VALIDATED.
            --
            -- The ERP stores local format ("08036443423") while the app's phone
            -- column is the LOGIN identifier in +234 form. Writing the ERP's
            -- format verbatim would both change a working login and let one
            -- person exist twice under two spellings of the same number, so it
            -- is normalised first.
            --
            -- The shape check is not fussiness. The feed contains malformed
            -- numbers — LATLEK's "0707459177" is ten digits where a Nigerian
            -- mobile has eleven — and phone is the OTP target as well as the
            -- login. Overwriting a working login with a number nobody can be
            -- reached on is worse than leaving it alone, so anything that is not
            -- a plausible Nigerian mobile resolves to NULL and stands down.
            (CASE
               WHEN length(s.digits) < 7      THEN NULL
               WHEN left(s.digits, 3) = '234' THEN '+' || s.digits
               WHEN left(s.digits, 1) = '0'   THEN '+234' || substr(s.digits, 2)
               ELSE '+234' || s.digits
             END)                                                             AS phone_raw,
            NULL::text                                                        AS phone,
            NULL::text                                                        AS conflict_with,
            cr.balance                                                        AS balance,
            TRUE                                                              AS phone_ok,
            NULL::text                                                        AS reject,
            NULL::text                                                        AS reject_detail
          FROM src s
          LEFT JOIN credit cr ON cr.code = s.erp_id
        `);

        const fetched = await this.count(tx, 'erp_proj_customer');
        if (fetched === 0) {
          await this.advanceWatermark(tx, JOB, 0, [
            { table: 'raw_customer', predicate: this.selector('raw_customer', wm, opts.full) },
            {
              table: 'raw_customer_credit',
              predicate: this.selector('raw_customer_credit', wm, opts.full),
            },
          ]);
          return { ...EMPTY(), notes };
        }

        // ── 2. Quarantine: not a Viju distributor ───────────────────────────
        await tx.$executeRawUnsafe(`
          UPDATE erp_proj_customer SET
            reject = 'NOT_A_VIJU_DISTRIBUTOR',
            reject_detail = 'BP_CLUSTER_CODE=' ||
              coalesce(NULLIF(cluster_code, ''), '<blank>') ||
              ' is not a Viju region code (expected 1-5)'
          WHERE reject IS NULL AND region IS NULL
        `);

        // ── 3. Phone safety ─────────────────────────────────────────────────
        //
        // Customer.phone is UNIQUE. An upsert conflict-targeting "erpId" that
        // happens to write a duplicate phone fails on a DIFFERENT constraint,
        // on a DIFFERENT row, and takes the whole batch with it. So the
        // collisions are found first and the offending rows are stood down —
        // one bad row costs one row, never the batch.

        // Keep only numbers that are plausibly reachable. Default is a Nigerian
        // mobile in E.164: +234, then 7/8/9, then 0/1, then eight digits.
        await tx.$executeRawUnsafe(
          `UPDATE erp_proj_customer SET phone = phone_raw WHERE phone_raw ~ $1`,
          opts.phonePattern,
        );
        await tx.$executeRawUnsafe(
          `UPDATE erp_proj_customer SET phone_ok = FALSE WHERE phone IS NULL`,
        );

        // Duplicated within this batch — every one of them is an offender, so
        // none of them wins the number.
        await tx.$executeRawUnsafe(`
          UPDATE erp_proj_customer c SET
            phone_ok = FALSE,
            conflict_with = dup.others
          FROM (
            SELECT phone, string_agg(erp_id, ', ' ORDER BY erp_id) AS others
            FROM erp_proj_customer
            WHERE reject IS NULL AND phone IS NOT NULL
            GROUP BY phone HAVING count(*) > 1
          ) dup
          WHERE c.phone = dup.phone
        `);

        // Already held by a DIFFERENT customer in the app. This is a real case,
        // not a theoretical one: ERP customer 10110001 (ABAYOMI) carries the
        // number that customer 10110017 (ISEA INTEGRATED) already logs in with.
        // §7 asks for the pair to be logged, so the other party's erpId is
        // recorded on the quarantine entry rather than just "duplicate phone".
        await tx.$executeRawUnsafe(`
          UPDATE erp_proj_customer c SET
            phone_ok = FALSE,
            conflict_with = coalesce(c.conflict_with || ' / ', '') || x."erpId"
          FROM public."Customer" x
          WHERE x.phone = c.phone AND x."erpId" IS DISTINCT FROM c.erp_id
        `);

        // A customer we have never seen cannot be created without a phone — it
        // is NOT NULL and it is the login. One that already exists keeps the
        // phone it has; the rest of its ERP-owned fields still update.
        //
        // ⚠️ THIS IS THE BINDING CONSTRAINT ON CUSTOMER COVERAGE, and it is a
        // data problem, not a code one: 1,844 of the 1,851 Viju distributors in
        // the feed carry the SAME placeholder PhoneNumber (0913580925). They
        // cannot all be created while phone is UNIQUE, so by default they are
        // quarantined with the reason recorded, and they convert into real
        // customers with no code change the moment the ERP supplies real
        // per-customer phones.
        //
        // ERP_CUSTOMER_SYNTHETIC_PHONE=true trades that off: the customer is
        // created with 'erp:<CUSTOMER_CODE>' as their phone. That value is
        // deliberately NOT dialable — it cannot collide with a real number and
        // cannot receive an OTP — so the distributor becomes visible to admins,
        // regional admins and account officers in the portal WITHOUT a fake
        // credential that someone could log in with. A later run replaces it the
        // instant the ERP sends a usable number.
        if (!opts.syntheticPhone) {
          await tx.$executeRawUnsafe(`
            UPDATE erp_proj_customer c SET
              reject = 'NO_USABLE_PHONE',
              reject_detail = CASE
                WHEN c.phone IS NULL
                  THEN 'ERP PhoneNumber ' ||
                       coalesce(NULLIF(c.phone_raw, ''), '<blank>') ||
                       ' is not a usable Nigerian mobile number'
                ELSE 'ERP PhoneNumber ' || c.phone ||
                     ' is already held by customer(s) ' ||
                     coalesce(c.conflict_with, '<unknown>') ||
                     ' — Customer.phone is UNIQUE'
              END
            WHERE c.reject IS NULL AND NOT c.phone_ok
              AND NOT EXISTS (SELECT 1 FROM public."Customer" x WHERE x."erpId" = c.erp_id)
          `);
        }

        // name is NOT NULL too, and the ERP is the only source for it.
        await tx.$executeRawUnsafe(`
          UPDATE erp_proj_customer c SET
            reject = 'NO_NAME',
            reject_detail = 'neither CUSTOMER_FULL_NAME nor CUSTOMER_NAME is set'
          WHERE c.reject IS NULL
            AND coalesce(c.name_full, c.name_alt) IS NULL
            AND NOT EXISTS (SELECT 1 FROM public."Customer" x WHERE x."erpId" = c.erp_id)
        `);

        const skipped = await this.count(
          tx,
          'erp_proj_customer',
          'reject IS NOT NULL',
        );

        // Existing customers whose ERP phone could not be applied. Not a
        // quarantine — the row still projects, only the phone field stands
        // down — but it must not be silent.
        const phoneHeld = await this.count(
          tx,
          'erp_proj_customer c',
          `c.reject IS NULL AND NOT c.phone_ok
             AND EXISTS (SELECT 1 FROM public."Customer" x WHERE x."erpId" = c.erp_id)`,
        );
        if (phoneHeld > 0) {
          notes.push(
            `${phoneHeld} existing customer(s) kept their current phone — the ERP's ` +
              `PhoneNumber for them is blank or shared with another customer`,
          );
        }

        if (opts.syntheticPhone) {
          const synthetic = await this.count(
            tx,
            'erp_proj_customer c',
            `c.reject IS NULL AND NOT c.phone_ok
               AND NOT EXISTS (SELECT 1 FROM public."Customer" x WHERE x."erpId" = c.erp_id)`,
          );
          if (synthetic > 0) {
            notes.push(
              `${synthetic} customer(s) created with a non-dialable 'erp:<CODE>' ` +
                `placeholder phone (ERP_CUSTOMER_SYNTHETIC_PHONE=true) — they are ` +
                `visible in the portal but cannot log in until the ERP sends a real number`,
            );
          }
        }

        await this.recordQuarantine(tx, JOB, 'CUSTOMER', 'erp_proj_customer', `
          jsonb_build_object(
            'CUSTOMER_CODE', c.erp_id,
            'BP_CLUSTER_CODE', c.cluster_code,
            'PhoneNumber', c.phone_raw,
            'conflictsWith', c.conflict_with)
        `);

        // ── 4. The upsert ───────────────────────────────────────────────────
        //
        // Every value is resolved in the SELECT against the row that already
        // exists (`ex`), so `EXCLUDED.<col>` is correct on BOTH branches and the
        // DO UPDATE clause stays a plain assignment. That is what lets
        // "a customer with no credit record is left as-is, never zeroed" and
        // "keep the app's phone when the ERP's is unusable" hold without a
        // second statement.
        //
        // The update clause touches name, phone, region, outstandingBalance and
        // updatedAt. Nothing else. email / password / failedLoginAttempts /
        // lockedUntil / profilePhotoUrl / accountStatus / assignedOfficerId /
        // createdAt are the application's and are not named here.
        const phoneExpr = opts.updatePhone
          ? `CASE WHEN c.phone_ok THEN c.phone ELSE COALESCE(ex.phone, ${placeholder}) END`
          : // Phone overwrite disabled: only ever set it when creating a row.
            `CASE WHEN ex.id IS NULL AND c.phone_ok THEN c.phone
                  ELSE COALESCE(ex.phone, ${placeholder}) END`;

        const projected = await tx.$executeRawUnsafe(`
          INSERT INTO public."Customer"
            (id, "erpId", name, phone, region, "outstandingBalance",
             "accountStatus", "failedLoginAttempts", "createdAt", "updatedAt")
          SELECT
            COALESCE(ex.id, gen_random_uuid()::text),
            c.erp_id,
            COALESCE(c.name_full, c.name_alt, ex.name),
            ${phoneExpr},
            COALESCE(c.region, ex.region::text)::"Region",
            -- numeric all the way to the column, unrounded: the ERP carries up
            -- to 4 dp and every one of them has to survive.
            COALESCE(c.balance, ex."outstandingBalance"::numeric, 0)::double precision,
            COALESCE(ex."accountStatus", 'ACTIVE'::"AccountStatus"),
            COALESCE(ex."failedLoginAttempts", 0),
            COALESCE(ex."createdAt", (c.changed_at AT TIME ZONE 'UTC')),
            -- "last updated" should say when the RECORD moved, not when we last
            -- looked at it, so this is the ERP row's own changed_at.
            (c.changed_at AT TIME ZONE 'UTC')
          FROM erp_proj_customer c
          LEFT JOIN public."Customer" ex ON ex."erpId" = c.erp_id
          WHERE c.reject IS NULL
            AND COALESCE(c.name_full, c.name_alt, ex.name) IS NOT NULL
            AND (${phoneExpr}) IS NOT NULL
          ON CONFLICT ("erpId") DO UPDATE SET
            name                 = EXCLUDED.name,
            phone                = EXCLUDED.phone,
            region               = EXCLUDED.region,
            "outstandingBalance" = EXCLUDED."outstandingBalance",
            "updatedAt"          = EXCLUDED."updatedAt"
        `);

        // ── 5. Close the loop on the raw rows ───────────────────────────────
        await tx.$executeRawUnsafe(`
          UPDATE erp_raw.raw_customer r
          SET projected_at = now(), project_error = NULL
          FROM erp_proj_customer c
          WHERE r.id = c.raw_id AND c.reject IS NULL
        `);
        await tx.$executeRawUnsafe(`
          UPDATE erp_raw.raw_customer r
          SET project_error = c.reject || ': ' || coalesce(c.reject_detail, '')
          FROM erp_proj_customer c
          WHERE r.id = c.raw_id AND c.reject IS NOT NULL
        `);
        // Credit rows drive this job too, so they are consumed here. Without
        // this they would stay projected_at IS NULL forever and every run would
        // re-scan the whole customer set.
        await tx.$executeRawUnsafe(`
          UPDATE erp_raw.raw_customer_credit c
          SET projected_at = now(), project_error = NULL
          WHERE ${creditSel}
        `);

        await this.advanceWatermark(tx, JOB, projected, [
          { table: 'raw_customer', predicate: this.selector('raw_customer', wm, opts.full) },
          {
            table: 'raw_customer_credit',
            predicate: this.selector('raw_customer_credit', wm, opts.full),
          },
        ]);

        return { fetched, projected, skipped, notes };
      },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PURCHASE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * erp_raw.raw_sales_order → public."Purchase", upserted on "erpId" ← DOC_NO.
   *
   * A raw sales-order row is ONE ORDER LINE, not one order: a seven-line order
   * is seven rows repeating the same DOC_NO and the same header totals. So the
   * lines are aggregated per DOC_NO, and the header figures (QTY_TOTAL,
   * AMT_UNINCLUDE_TAX_OC, TAX_OC) are taken from a single representative line —
   * summing them would multiply each by the number of lines.
   *
   * ⚠️ The aggregate is taken over EVERY line of an affected order, not just the
   * lines that changed. If line 3 of 7 moves, deriving the order's status from
   * line 3 alone would be wrong.
   *
   * ─── Why `status` is not in the update clause ──────────────────────────────
   *
   * The old projector wrote a constant (ApproveStatus 'Y' → PROCESSING) on every
   * update. It no longer does — but it does not write a derived status on update
   * either, because OrderStatus in the live database carries LOADED and
   * DISPATCHED, which are the app's own fulfilment workflow and have no ERP
   * counterpart at all. An ERP-derived status on update would silently reset a
   * loading officer's work to PROCESSING. `status` is therefore derived properly
   * for a NEW order (see below) and thereafter owned by the backend's own
   * reconciler, which POST /api/v1/erp/sync/order-status re-runs after every
   * successful sync.
   */
  async projectPurchases(opts: {
    full: boolean;
    /** ApproveStatus values that make an order eligible at all. */
    eligibleApproveStatuses: string[];
    statementTimeoutMs: number;
    txTimeoutMs: number;
    /** Raw rows one run may scan. See the cap note inside. */
    maxRowsPerRun: number;
  }): Promise<ProjectionResult> {
    const JOB = 'project:purchase';
    const eligible = opts.eligibleApproveStatuses.map(lit).join(', ');
    if (!eligible) return { ...EMPTY(), notes: ['no eligible ApproveStatus values configured'] };

    return this.pass(
      JOB,
      opts.statementTimeoutMs,
      opts.txTimeoutMs,
      async (tx, wm) => {
        const notes: string[] = [];
        const sel = this.selector('r', wm, opts.full);

        // ── The slice this run takes ────────────────────────────────────
        //
        // A run reads the NEXT SLICE of the feed by id, not the whole selector.
        //
        // Why a slice at all: the selector re-reads every row with projected_at
        // IS NULL, and 1.94M of the 1.99M sales-order rows are permanently in
        // that state — their distributor has not onboarded, so they are left
        // queued on purpose. Unbounded, one run therefore hashed and sorted the
        // entire table every three minutes. Measured on 2026-09-16: 890 GB of
        // temp files in twenty hours, the server's disk full, and this job
        // failing with 53100 for nine days straight.
        //
        // Why by id and not by a "retry later" stamp on the row: a raw row is a
        // ~1.5KB JSONB payload and Postgres rewrites the whole row to change one
        // field, so stamping the backlog would have written ~3GB — on the disk
        // that had just run out. The cursor writes ONE row per run and gives the
        // same guarantee: the next run starts where this one stopped.
        //
        // Reaching the end wraps the cursor back to 0, and only THAT run may
        // advance the watermark — it is the one that has seen the whole feed.
        const maxRows = Math.max(1_000, opts.maxRowsPerRun);
        const cursor = await this.scanCursor(tx, JOB);

        await tx.$executeRawUnsafe(`
          CREATE TEMP TABLE erp_proj_slice ON COMMIT DROP AS
          SELECT r.id, r.payload->>'DOC_NO' AS doc_no_raw
          FROM erp_raw.raw_sales_order r
          WHERE ${sel}
            AND r.id > ${cursor}
            AND NULLIF(btrim(coalesce(r.payload->>'DOC_NO', '')), '') IS NOT NULL
          ORDER BY r.id
          LIMIT ${maxRows}
        `);

        const edge = await tx.$queryRawUnsafe<{ n: bigint; max_id: bigint | null }[]>(
          `SELECT count(*)::bigint AS n, max(id)::bigint AS max_id FROM erp_proj_slice`,
        );
        const sliceRows = Number(edge[0]?.n ?? 0);
        const truncated = sliceRows >= maxRows;
        await this.setScanCursor(
          tx,
          JOB,
          truncated ? Number(edge[0]?.max_id ?? 0) : 0,
        );

        // Distinct documents in the slice. A document whose lines straddle the
        // slice boundary is still aggregated in FULL, because the line pass below
        // re-reads every line of each document named here.
        await tx.$executeRawUnsafe(`
          CREATE TEMP TABLE erp_proj_doc ON COMMIT DROP AS
          SELECT DISTINCT doc_no_raw FROM erp_proj_slice
        `);
        await tx.$executeRawUnsafe(
          `CREATE INDEX ON erp_proj_doc (doc_no_raw)`,
        );
        // A temp table carries no statistics of its own, and every join below
        // drives off this one. Without this the planner sizes it by a hardcoded
        // guess and picks the wrong join shape for it.
        await tx.$executeRawUnsafe(`ANALYZE erp_proj_doc`);

        // Every LINE of those orders, flattened to SCALARS — never the payload.
        //
        // ⚠️ This table must not carry `payload`. It used to: `lines` was a CTE
        // selecting r.payload, read twice (by `agg` and by `hdr`). Postgres 10
        // ALWAYS materialises a CTE, so each run wrote every selected row's full
        // JSONB to a temp file and then sorted it again for the DISTINCT ON.
        //
        // That is fine while the selected set is small. It is not fine here,
        // because `sel` re-selects every row with projected_at IS NULL — and
        // 1.94M of the 1.99M sales-order rows are permanently in that state
        // (their customer has not onboarded, so they are deliberately left
        // queued). So a 3 GB table was materialised and re-sorted every three
        // minutes: 890 GB of temp files in twenty hours, which filled the
        // server's disk and made the job fail with 53100 for nine days straight.
        //
        // Extracting the eleven scalars we actually use drops the same row set
        // from ~3 GB to ~200 MB. This is exactly the shape projectPayments has
        // always used, which is why that job never hit the wall.
        await tx.$executeRawUnsafe(`
          CREATE TEMP TABLE erp_proj_line ON COMMIT DROP AS
          SELECT
            btrim(d.doc_no_raw) AS doc_no,
            r.id,
            r.changed_at,
            btrim(coalesce(r.payload->>'ApproveStatus', '')) AS approve_status,
            btrim(coalesce(r.payload->>'CLOSE', ''))         AS close_status,
            ${num("r.payload->>'BUSINESS_QTY'")}             AS qty_ordered,
            ${num("r.payload->>'DELIVERED_BUSINESS_QTY'")}   AS qty_delivered,
            r.payload->>'CUSTOMER_ID'                        AS customer_guid,
            ${ts("r.payload->>'ORDER_DATE'")}                AS order_date,
            (${num("r.payload->>'QTY_TOTAL'")})::int         AS total_items,
            (${num("r.payload->>'AMT_UNINCLUDE_TAX_OC'")}
           + ${num("r.payload->>'TAX_OC'")})::double precision AS total_value
          FROM erp_raw.raw_sales_order r
          -- ⚠️ JOIN ON THE UNTRIMMED VALUE. raw_sales_order_doc_no_idx is on
          -- (payload->>'DOC_NO') with no btrim around it, so joining on
          -- btrim(...) cannot use it — and the planner's answer to that was a
          -- MERGE JOIN, which sorts all 1.99M rows at full width, payload and
          -- all: a ~2.5GB spill every run. That is where the 890 GB of temp
          -- files came from, and with it the server's disk. Matching the index's
          -- exact expression makes this an index lookup per document instead.
          -- Both sides read the same column, so the raw values compare exactly;
          -- the trim belongs on the OUTPUT, and that is where it now is.
          JOIN erp_proj_doc d ON d.doc_no_raw = r.payload->>'DOC_NO'
        `);

        // Aggregate ALL lines of those orders, plus a representative header row.
        await tx.$executeRawUnsafe(`
          CREATE TEMP TABLE erp_proj_purchase ON COMMIT DROP AS
          WITH agg AS (
            SELECT
              doc_no,
              max(changed_at) AS changed_at,
              bool_and(approve_status IN (${eligible})) AS eligible,
              bool_and(approve_status = 'Y')            AS all_approved,
              bool_and(close_status = '2')              AS all_closed,
              sum(qty_ordered)                          AS qty_ordered,
              sum(qty_delivered)                        AS qty_delivered
            FROM erp_proj_line GROUP BY doc_no
          ), hdr AS (
            SELECT DISTINCT ON (doc_no)
              doc_no, customer_guid, order_date, total_items, total_value
            FROM erp_proj_line ORDER BY doc_no, id
          )
          SELECT
            a.doc_no,
            a.changed_at,
            a.eligible,
            cust.id AS customer_id,
            h.order_date,
            -- header totals: taken ONCE, never summed across the lines
            h.total_items,
            h.total_value,
            -- §4's derivation, in its stated order of precedence. Used on INSERT
            -- only; see the note above the method.
            (CASE
               WHEN NOT a.all_approved                                   THEN 'PENDING'
               WHEN a.all_closed                                         THEN 'CLOSED'
               WHEN a.qty_ordered > 0
                    AND a.qty_delivered >= a.qty_ordered                 THEN 'DELIVERED'
               ELSE 'PROCESSING'
             END) AS status
          FROM agg a
          JOIN hdr h ON h.doc_no = a.doc_no
          LEFT JOIN erp_raw.customer_link cl
            ON cl.erp_customer_guid = h.customer_guid
          LEFT JOIN public."Customer" cust
            ON cust."erpId" = cl.erp_customer_code AND cust.password IS NOT NULL
        `);

        const fetched = await this.count(tx, 'erp_proj_purchase');
        if (fetched === 0) {
          await this.advanceWatermark(tx, JOB, 0, [
            {
              table: 'raw_sales_order',
              predicate: this.selector('raw_sales_order', wm, opts.full),
            },
          ]);
          return { ...EMPTY(), notes };
        }

        // Not projectable YET — deliberately NOT quarantined. The customer may
        // simply not have onboarded (transactions are projected on demand, when
        // a distributor starts using the app). Leaving projected_at NULL is what
        // makes those orders appear by themselves the moment they do.
        const deferred = await this.count(
          tx,
          'erp_proj_purchase',
          'customer_id IS NULL OR order_date IS NULL OR NOT eligible',
        );
        if (deferred > 0) {
          notes.push(
            `${deferred} order(s) left queued — customer not onboarded, no ORDER_DATE, ` +
              `or an ApproveStatus outside ERP_STATUS_MAP`,
          );
        }

        const projected = await tx.$executeRawUnsafe(`
          INSERT INTO public."Purchase"
            (id, "erpId", "customerId", "orderDate", "totalItems", "totalValue",
             status, "createdAt", "updatedAt")
          SELECT
            COALESCE(ex.id, gen_random_uuid()::text),
            p.doc_no, p.customer_id, p.order_date, p.total_items, p.total_value,
            COALESCE(ex.status, p.status::"OrderStatus"),
            COALESCE(ex."createdAt", (p.changed_at AT TIME ZONE 'UTC')),
            (p.changed_at AT TIME ZONE 'UTC')
          FROM erp_proj_purchase p
          LEFT JOIN public."Purchase" ex ON ex."erpId" = p.doc_no
          WHERE p.eligible AND p.customer_id IS NOT NULL AND p.order_date IS NOT NULL
          ON CONFLICT ("erpId") DO UPDATE SET
            "customerId" = EXCLUDED."customerId",
            "orderDate"  = EXCLUDED."orderDate",
            "totalItems" = EXCLUDED."totalItems",
            "totalValue" = EXCLUDED."totalValue",
            "updatedAt"  = EXCLUDED."updatedAt"
        `);

        // Mark every LINE of a projected order, not just the changed ones — the
        // whole order was consumed.
        await tx.$executeRawUnsafe(`
          UPDATE erp_raw.raw_sales_order r
          SET projected_at = now(), project_error = NULL
          FROM erp_proj_purchase p
          JOIN erp_proj_doc d ON btrim(d.doc_no_raw) = p.doc_no
          WHERE r.payload->>'DOC_NO' = d.doc_no_raw
            AND p.eligible AND p.customer_id IS NOT NULL AND p.order_date IS NOT NULL
        `);

        // A capped run has not seen the whole feed. Advancing the watermark here
        // would declare rows it never looked at as seen, and they would only ever
        // come back through the projected_at half of the selector.
        if (truncated) {
          notes.push(
            `scan capped at ${maxRows} row(s) — watermark held; the next run picks up ` +
              `where this one stopped`,
          );
          return { fetched, projected, skipped: deferred, notes };
        }

        await this.advanceWatermark(tx, JOB, projected, [
          {
            table: 'raw_sales_order',
            predicate: this.selector('raw_sales_order', wm, opts.full),
          },
        ]);

        return { fetched, projected, skipped: deferred, notes };
      },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PAYMENT
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * erp_raw.raw_collection → public."Payment", upserted on "erpId" ← DOC_NO.
   *
   * ⚠️ Payment."erpId" is NULLABLE and UNIQUE, and ON CONFLICT does not fire for
   * NULLs — a payment projected without one would duplicate on every single run.
   * So an erpId is REQUIRED here: a collection with no DOC_NO is left queued
   * rather than inserted without a key.
   *
   * runningBalance is the application's (it is a ledger position the backend
   * maintains, not something the ERP sends) and is written only on insert.
   */
  async projectPayments(opts: {
    full: boolean;
    statementTimeoutMs: number;
    txTimeoutMs: number;
  }): Promise<ProjectionResult> {
    const JOB = 'project:payment';

    return this.pass(
      JOB,
      opts.statementTimeoutMs,
      opts.txTimeoutMs,
      async (tx, wm) => {
        const notes: string[] = [];
        const sel = this.selector('r', wm, opts.full);

        await tx.$executeRawUnsafe(`
          CREATE TEMP TABLE erp_proj_payment ON COMMIT DROP AS
          SELECT
            r.id AS raw_id,
            NULLIF(btrim(coalesce(r.payload->>'DOC_NO', r.erp_key, '')), '') AS erp_id,
            r.changed_at,
            cust.id AS customer_id,
            ${ts("r.payload->>'DOC_DATE'")} AS paid_at,
            (${num("r.payload->>'COLLECTION_AMT_TC'")})::double precision AS amount
          FROM erp_raw.raw_collection r
          LEFT JOIN public."Customer" cust
            ON cust."erpId" = r.payload->>'CUSTOMER_CODE' AND cust.password IS NOT NULL
          WHERE ${sel}
        `);

        const fetched = await this.count(tx, 'erp_proj_payment');
        if (fetched === 0) {
          await this.advanceWatermark(tx, JOB, 0, [
            {
              table: 'raw_collection',
              predicate: this.selector('raw_collection', wm, opts.full),
            },
          ]);
          return { ...EMPTY(), notes };
        }

        const deferred = await this.count(
          tx,
          'erp_proj_payment',
          'customer_id IS NULL OR paid_at IS NULL OR erp_id IS NULL',
        );
        if (deferred > 0) {
          notes.push(
            `${deferred} collection(s) left queued — customer not onboarded, ` +
              `no DOC_DATE, or no DOC_NO to key on`,
          );
        }

        const projected = await tx.$executeRawUnsafe(`
          INSERT INTO public."Payment"
            (id, "erpId", "customerId", date, amount, reference, "runningBalance", "createdAt")
          SELECT
            COALESCE(ex.id, gen_random_uuid()::text),
            p.erp_id, p.customer_id, p.paid_at, p.amount, p.erp_id,
            COALESCE(ex."runningBalance", 0),
            COALESCE(ex."createdAt", (p.changed_at AT TIME ZONE 'UTC'))
          FROM erp_proj_payment p
          LEFT JOIN public."Payment" ex ON ex."erpId" = p.erp_id
          WHERE p.customer_id IS NOT NULL AND p.paid_at IS NOT NULL AND p.erp_id IS NOT NULL
          ON CONFLICT ("erpId") DO UPDATE SET
            "customerId" = EXCLUDED."customerId",
            date         = EXCLUDED.date,
            amount       = EXCLUDED.amount,
            reference    = EXCLUDED.reference
        `);

        await tx.$executeRawUnsafe(`
          UPDATE erp_raw.raw_collection r
          SET projected_at = now(), project_error = NULL
          FROM erp_proj_payment p
          WHERE r.id = p.raw_id
            AND p.customer_id IS NOT NULL AND p.paid_at IS NOT NULL AND p.erp_id IS NOT NULL
        `);

        await this.advanceWatermark(tx, JOB, projected, [
          {
            table: 'raw_collection',
            predicate: this.selector('raw_collection', wm, opts.full),
          },
        ]);

        return { fetched, projected, skipped: deferred, notes };
      },
    );
  }

  // ─── Shared bits ──────────────────────────────────────────────────────────

  /**
   * Where the last run of this job stopped reading, as a raw-table id.
   *
   * Kept in erp_raw.sync_cursor beside the ingest's own page cursors, and read
   * and written INSIDE the projection's transaction — so a run that rolls back
   * leaves the cursor where it was and re-reads the same slice, rather than
   * skipping it.
   */
  private async scanCursor(tx: TxClient, job: string): Promise<number> {
    const rows = await tx.$queryRawUnsafe<{ cursor_value: string | null }[]>(
      `SELECT cursor_value FROM erp_raw.sync_cursor WHERE job = ${lit('scan:' + job)}`,
    );
    const value = Number(rows[0]?.cursor_value ?? 0);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  /** Record where this run stopped. 0 means "start again from the beginning". */
  private async setScanCursor(tx: TxClient, job: string, id: number): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO erp_raw.sync_cursor (job, cursor_value, updated_at)
       VALUES (${lit('scan:' + job)}, ${lit(String(Math.max(0, Math.floor(id))))}, now())
       ON CONFLICT (job) DO UPDATE
         SET cursor_value = EXCLUDED.cursor_value, updated_at = now()`,
    );
  }


  private async count(tx: TxClient, from: string, where = 'TRUE'): Promise<number> {
    const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM ${from} WHERE ${where}`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Record (or refresh) the quarantine entries for a candidate table, and clear
   * the ones that have started projecting again — a row that was refused for a
   * blank region and now has one should not linger in the report forever.
   */
  private async recordQuarantine(
    tx: TxClient,
    job: string,
    objectType: string,
    table: string,
    payloadExpr: string,
  ): Promise<void> {
    await tx.$executeRawUnsafe(`
      INSERT INTO erp_raw.projection_quarantine
        (job, object_type, erp_key, reason, detail, payload)
      SELECT ${lit(job)}, ${lit(objectType)}, c.erp_id, c.reject, c.reject_detail,
             ${payloadExpr}
      FROM ${table} c
      WHERE c.reject IS NOT NULL
      ON CONFLICT (job, erp_key) DO UPDATE SET
        reason       = EXCLUDED.reason,
        detail       = EXCLUDED.detail,
        payload      = EXCLUDED.payload,
        last_seen_at = now(),
        resolved_at  = NULL
    `);

    await tx.$executeRawUnsafe(`
      UPDATE erp_raw.projection_quarantine q SET resolved_at = now()
      FROM ${table} c
      WHERE q.job = ${lit(job)} AND q.erp_key = c.erp_id
        AND c.reject IS NULL AND q.resolved_at IS NULL
    `);
  }
}

/** The subset of the Prisma transaction client this file uses. */
interface TxClient {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
}
