import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErpClient } from '../../erp/erp.client';
import { ErpApiError } from '../../erp/erp.errors';
import { ERP_METHOD, ErpCondition, ErpMethod, ErpOrder } from '../../erp/erp.types';
import { ErpObjectType, RawRepository } from '../../raw/raw.repository';
import { JobStats, SyncJob } from '../sync.job';

/**
 * A job that can re-read a stated window on demand. Every ingest job can; the
 * projections cannot, and the scheduler is handed SyncJob[] — so this is the
 * narrow surface it tests for rather than exporting the whole base class.
 */
export interface Backfillable {
  backfill(window: { field: string; from: string; to: string }): Promise<JobStats>;
}

export const isBackfillable = (job: unknown): job is Backfillable =>
  typeof (job as Backfillable | undefined)?.backfill === 'function';


/**
 * Ingest = ERP → erp_raw. Verbatim, no interpretation.
 *
 * These jobs are unaffected by the mapping gaps in CONTRACT.md: capturing what
 * the ERP actually sends does not require us to understand it yet. That makes
 * them worth running from day one — the raw payloads are themselves the evidence
 * that answers most of the open questions.
 */
// @Injectable() is load-bearing here — the concrete jobs below inherit this
// constructor rather than declaring their own, and Nest needs the metadata.
@Injectable()
abstract class IngestJob extends SyncJob {
  protected abstract readonly method: ErpMethod;
  protected abstract readonly objectType: ErpObjectType;
  /** The ERP's own identifier for this object (CUSTOMER_CODE, DOC_NO, ...). */
  protected abstract keyOf(row: Record<string, unknown>): string | undefined;

  constructor(
    raw: RawRepository,
    protected readonly erp: ErpClient,
    protected readonly config: ConfigService,
  ) {
    super(raw);
  }

  /**
   * Set once per process when the ERP rejects the incremental column, so the
   * fallback is logged once rather than on every sweep of every object.
   */
  private static incrementalUnavailable = false;

  /**
   * The `conditions` filter for this sweep, or [] for a full sweep.
   *
   * Full sweep when: incremental is off, the column is missing on this ERP build,
   * the job has never completed a sweep, or the last FULL sweep is older than
   * ERP_FULL_SWEEP_DAYS. That last one is the safety net — see needsFullSweep().
   */
  private async incrementalConditions(): Promise<{
    conditions: ErpCondition[];
    since: string | null;
  }> {
    // Objects small enough to re-read in full every cycle do exactly that. A
    // full sweep is the only kind that reconciles, so ghosts left by a changed
    // key never outlive one cycle — which is what makes it safe for
    // customer_credit to key on a mutable amount. customer_credit is ~1,800
    // rows (about 40s); the million-row objects stay incremental.
    const alwaysFull = (this.config.get<string>('ERP_FULL_SWEEP_JOBS') ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    if (alwaysFull.includes(this.name)) return { conditions: [], since: null };

    const enabled = this.config.get<boolean>('ERP_INCREMENTAL') ?? true;
    if (!enabled || IngestJob.incrementalUnavailable) return { conditions: [], since: null };

    const watermark = await this.raw.getWatermark(this.name);
    if (!watermark) return { conditions: [], since: null };

    if (await this.needsFullSweep()) {
      this.logger.log(
        `${this.name}: forcing a FULL sweep — the last one is older than ` +
          `${this.config.get<number>('ERP_FULL_SWEEP_DAYS') ?? 7} day(s). This is the ` +
          `backstop for rows the ERP changes WITHOUT moving LastModifiedDate, and for ` +
          `back-dated edits an incremental filter can never see.`,
      );
      return { conditions: [], since: null };
    }

    const overlapMin = this.config.get<number>('ERP_INCREMENTAL_OVERLAP_MINUTES') ?? 30;
    const field = this.config.get<string>('ERP_INCREMENTAL_FIELD') ?? 'LastModifiedDate';
    const since = this.shiftErpTimestamp(watermark, overlapMin);

    return {
      since,
      conditions: [{ field_name: field, operator: '>=', value: since }],
    };
  }

  /** True when this job has not done a full, unfiltered sweep recently. */
  private async needsFullSweep(): Promise<boolean> {
    const days = this.config.get<number>('ERP_FULL_SWEEP_DAYS') ?? 7;
    if (days <= 0) return false; // disabled

    const last = await this.raw.watermarkUpdatedAt(this.name);
    if (!last) {
      // No record yet. We only get here when a watermark EXISTS, so a sweep did
      // complete at some point — this marker simply predates the feature. Start
      // the clock now rather than forcing a full sweep of every object at once,
      // which on sales_order means ~9,800 pages for nothing.
      await this.raw.markFullSweep(this.name);
      return false;
    }

    return Date.now() - last.getTime() >= days * 24 * 60 * 60_000;
  }

  /**
   * Subtract minutes from an ERP timestamp, staying entirely in the ERP's clock.
   *
   * The value is parsed as if it were UTC purely so Date can do the arithmetic;
   * it is formatted straight back to the same `YYYY-MM-DD HH:mm:ss` shape. No
   * timezone conversion happens, which is the point — our clock never enters into
   * a comparison against the ERP's own timestamps.
   */
  private shiftErpTimestamp(value: string, minutesEarlier: number): string {
    // Accept both shapes: the ERP's own `YYYY-MM-DD HH:mm:ss`, and the ISO
    // strings written by the older clock-based watermark that may still be in the
    // cursor table. Sending an ISO string to the ERP is not something it accepts.
    const normalised = value.includes('T') ? value.replace('T', ' ').slice(0, 19) : value;
    const parsed = new Date(`${normalised.replace(' ', 'T')}Z`);
    if (Number.isNaN(parsed.getTime())) return value;
    return new Date(parsed.getTime() - minutesEarlier * 60_000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
  }

  /**
   * True when the ERP rejected the filter because the column does not exist on
   * this build (CE66014 "找不到别名为X的查询列" / "cannot find query column").
   *
   * This is the difference between "the docs promise LastModifiedDate" and "this
   * server has it". As of 2026-08-23 the docs list it on all eight objects but
   * the live server does NOT, so filtering fails outright. Treating that as a
   * signal to fall back — rather than a fatal error — means the filter can ship
   * now and starts working by itself the moment the ERP deploys it.
   */
  private isUnknownColumn(error: unknown): boolean {
    if (!(error instanceof ErpApiError)) return false;
    const text = String(error.message);
    return /CE66014|找不到别名|cannot find query column/i.test(text);
  }

  protected async execute(): Promise<JobStats> {
    let fetched = 0;
    let changed = 0;
    let pages = 0;
    let lastPage = 0;

    const table = this.raw.tableFor(this.objectType);

    // Resume an interrupted sweep instead of restarting from page 1. The cursor
    // is only set mid-sweep; a clean finish clears it (below), so a normal cycle
    // always starts fresh at page 1.
    const startPage = await this.raw.getIngestPage(this.name);

    // Stamped BEFORE the sweep: anything modified while it runs must be picked up
    // next time, not skipped because we stamped the finish time.
    const { conditions, since } = await this.incrementalConditions();
    const isFullSweep = conditions.length === 0;

    // The highest LastModifiedDate actually returned. This — not our clock —
    // becomes the next watermark, so the comparison always happens in the ERP's
    // own time. Stays null if the ERP sends no such field.
    let maxSeen: string | null = null;

    // Time budget for THIS turn. A full sales-order sweep runs 8-14 hours, and
    // while it holds the ingest lock every other object is frozen out — customer
    // credit went four days without a refresh for exactly this reason. The page
    // cursor already lets a sweep resume, so a big object can take its time across
    // many short turns instead of monopolising the worker in one long one.
    const budgetMs = (this.config.get<number>('ERP_SWEEP_MAX_MINUTES') ?? 10) * 60_000;
    const sweepStartedAt = Date.now();
    let outOfTime = false;

    // Full sweeps also RECONCILE: they record every key returned and afterwards
    // delete the rows that were not. That is what removes ghosts left behind when
    // the ERP edits a record's key fields (customer_credit's EFFECTIVE_DATE moved
    // from 0001-01-01 to 2026-09-02 and the old row stayed forever), and rows
    // genuinely deleted in the ERP. Never done on an incremental sweep, which by
    // definition only sees what changed.
    const reconcile = isFullSweep && (this.config.get<boolean>('ERP_RECONCILE_DELETES') ?? true);
    const sweepId = `${this.name}:${Date.now()}`;
    if (reconcile) {
      // Clear anything a previously killed sweep of this object left behind.
      await this.raw.clearStaleSeen(this.objectType, sweepId);
    }
    const field = this.config.get<string>('ERP_INCREMENTAL_FIELD') ?? 'LastModifiedDate';

    this.logger.log(
      `${this.name}: sweeping ${this.method} → erp_raw.${table}` +
        (since ? ` (incremental: changed since ${since})` : ' (full sweep)') +
        (startPage > 1 ? ` (resuming from page ${startPage})` : ''),
    );

    for await (const { pageNo, rows } of this.sweep(conditions, startPage)) {
      pages++;
      lastPage = pageNo;
      const result = await this.raw.upsertMany(this.objectType, rows, (row) =>
        this.keyOf(row),
      );
      fetched += result.fetched;
      changed += result.changed;

      for (const row of rows) {
        const value = row[field];
        if (typeof value === 'string' && (maxSeen === null || value > maxSeen)) {
          maxSeen = value; // 'YYYY-MM-DD HH:mm:ss' sorts correctly as text
        }
      }

      this.logger.log(
        `${this.name}: page ${pageNo} — stored ${result.fetched} row(s) ` +
          `(${result.changed} new/changed) into erp_raw.${table}`,
      );

      if (reconcile) {
        await this.raw.recordSeen(
          this.objectType,
          sweepId,
          rows.map((row) => this.keyOf(row)).filter((k): k is string => !!k),
        );
      }

      await this.afterPage(rows);
      // Persist progress so a restart resumes from the next page, not page 1.
      await this.raw.setIngestPage(this.name, pageNo + 1);

      if (budgetMs > 0 && Date.now() - sweepStartedAt >= budgetMs) {
        outOfTime = true;
        this.logger.log(
          `${this.name}: pausing after page ${pageNo} — this turn's ${Math.round(
            (Date.now() - sweepStartedAt) / 60_000,
          )}m is up. Resumes at page ${pageNo + 1}; other objects get a turn now.`,
        );
        break;
      }
    }

    // Swept to the end cleanly — reset the page cursor, and move the watermark so
    // the NEXT sweep only asks for what changed after this one started.

    // Paused, not finished: leave the page cursor and do NOT touch the watermark.
    // Advancing it here would declare everything up to now "seen" while most of
    // the sweep is still ahead of us.
    if (outOfTime) {
      // Incomplete key set — deleting against it would wipe the object.
      if (reconcile) await this.raw.clearSeen(sweepId);
      return { fetched, changed };
    }

    await this.raw.clearIngestPage(this.name);

    // Reconcile: drop rows this full sweep never returned.
    if (reconcile) {
      try {
        const seen = await this.raw.seenCount(sweepId);
        const held = await this.raw.rowCount(this.objectType);

        // Refuse to reconcile against a suspiciously thin key set. A sweep that
        // silently returned a fraction of the object (a bad page, an ERP filter
        // change) would otherwise delete most of the table.
        if (seen === 0 || seen * 2 < held) {
          this.logger.warn(
            `${this.name}: SKIPPING reconciliation — the sweep saw ${seen} key(s) but ` +
              `${held} row(s) are held. That gap is too large to trust; nothing deleted.`,
          );
        } else {
          const removed = await this.raw.deleteUnseen(this.objectType, sweepId);
          if (removed > 0) {
            this.logger.log(
              `${this.name}: removed ${removed} stale row(s) the ERP no longer returns ` +
                `(deleted there, or left behind when a record's key fields were edited).`,
            );
          }
        }
      } finally {
        await this.raw.clearSeen(sweepId);
      }
    }

    // Advance the watermark even when this sweep had to run in full: it records
    // "everything up to here has been seen", which is true either way. Keeping it
    // current means that the day the ERP deploys LastModifiedDate, the first
    // filtered sweep asks for a sensible window instead of re-reading history.
    if (this.config.get<boolean>('ERP_INCREMENTAL') ?? true) {
      // Only advance when the data gave us something newer. A sweep that returned
      // nothing must NOT push the watermark forward, or the window it covered
      // would be skipped for good.
      const previous = await this.raw.getWatermark(this.name);
      if (maxSeen && (previous === null || maxSeen > previous)) {
        await this.raw.setWatermark(this.name, maxSeen);
      }
      // `isFullSweep` was decided BEFORE the sweep; the fallback can turn a
      // filtered sweep into a full one at runtime, and that still counts.
      if (isFullSweep || IngestJob.incrementalUnavailable) {
        await this.raw.markFullSweep(this.name);
      }
    }

    if (pages === 0) {
      this.logger.log(`${this.name}: ${this.method} returned no rows`);
    } else {
      this.logger.log(
        `${this.name}: done — ${fetched} row(s) total, ${changed} new/changed, ` +
          `through page ${lastPage} into erp_raw.${table}`,
      );
    }

    return { fetched, changed };
  }

  /**
   * Page through the ERP with the given filter, falling back to an unfiltered
   * sweep if the ERP does not know the incremental column on this build.
   *
   * The fallback has to live here, wrapping the generator, because the rejection
   * only surfaces when the first page is actually requested.
   */
  /**
   * Sort every sweep by the modified date, oldest first.
   *
   * ⚠️ This is a correctness fix, not a nicety. Paging an UNORDERED result set is
   * only safe if the data holds still, and ours does not: a sales-order sweep is
   * ~9,800 pages and takes days, while the ERP keeps inserting and updating
   * underneath it. Rows then shift between pages and some are never returned on
   * any page — which is exactly how raw_sales_order ended up stuck at
   * "newest change 2026-05-12" while the ERP had changes through 2026-08-04.
   *
   * Ascending is the right direction: new and freshly-modified rows land at the
   * END, after the pages already walked, instead of shuffling earlier ones.
   */
  private sweepOrder(): ErpOrder[] {
    const field = this.config.get<string>('ERP_INCREMENTAL_FIELD') ?? 'LastModifiedDate';
    return [{ field_name: field, order_type: 'asc' }];
  }

  private async *sweep(
    conditions: ErpCondition[],
    startPage: number,
  ): AsyncGenerator<{ pageNo: number; rows: Record<string, unknown>[] }, void, void> {
    const orders = this.sweepOrder();

    if (conditions.length === 0) {
      yield* this.erp.queryAll<Record<string, unknown>>(this.method, { orders }, startPage);
      return;
    }

    const filtered = this.erp.queryAll<Record<string, unknown>>(
      this.method,
      { conditions, orders },
      startPage,
    );

    try {
      // Pull the first page inside the try: that is where the ERP tells us
      // whether it knows the column.
      const first = await filtered.next();
      if (!first.done) yield first.value;
      if (!first.done) yield* filtered;
      return;
    } catch (error) {
      if (!this.isUnknownColumn(error)) throw error;

      if (!IngestJob.incrementalUnavailable) {
        IngestJob.incrementalUnavailable = true;
        this.logger.warn(
          `${this.config.get<string>('ERP_INCREMENTAL_FIELD') ?? 'LastModifiedDate'} is not available on this ERP ` +
            `build — falling back to FULL sweeps for every object. The API docs list it, but the server ` +
            `rejects it (CE66014). No change is needed here once the ERP deploys it: this flag resets on restart ` +
            `and the filter is used again automatically.`,
        );
      }
    }

    // Fallback: same sweep, unfiltered but still ordered.
    yield* this.erp.queryAll<Record<string, unknown>>(this.method, { orders }, startPage);
  }

  /** Hook for per-page side effects (e.g. maintaining the customer Guid bridge). */
  protected async afterPage(_page: Record<string, unknown>[]): Promise<void> {}

  /**
   * Re-read ONE WINDOW of this object, outside the normal sweep.
   *
   * Why this exists. The sweep walks the whole feed in LastModifiedDate order,
   * oldest first, ten minutes at a time, resuming from a page cursor — so when
   * the ERP adds FIELDS to an object (sales_delivery gained its subtable: AMOUNT,
   * PRICE, ITEM_CODE, ITEM_DESCRIPTION, ITEM_SPECIFICATION, BUSINESS_QTY), the
   * rows already stored keep their old, narrower shape until the sweep reaches
   * them again. On sales_delivery that is roughly a fortnight, and it arrives in
   * the worst possible order: 2016 first, this year last. The rows anyone
   * actually needs are the ones that stay wrong longest.
   *
   * A backfill re-reads a stated window NOW and upserts it through the ordinary
   * key, so those rows take their current shape immediately. It deliberately
   * touches NOTHING else:
   *
   *   • no page cursor    — the running sweep resumes exactly where it paused
   *   • no watermark      — this is not a sweep and must not stand in for one
   *   • no reconciliation — a window's key set says nothing about the rest of
   *                         the feed, and deleting against it would be a wipe
   *   • no unknown-column fallback — sweep() answers a rejected filter by
   *                         re-reading EVERYTHING unfiltered, which for a
   *                         backfill would be ten thousand pages by mistake. A
   *                         window the ERP will not filter on is an error here.
   */
  async backfill(window: {
    field: string;
    from: string;
    to: string;
  }): Promise<JobStats> {
    const table = this.raw.tableFor(this.objectType);
    const conditions: ErpCondition[] = [
      { field_name: window.field, operator: '>=', value: window.from },
      { field_name: window.field, operator: '<=', value: window.to },
    ];

    const runId = await this.raw.startRun(`${this.name}:backfill`);
    const startedAt = Date.now();
    let fetched = 0;
    let changed = 0;
    let pages = 0;

    this.logger.log(
      `${this.name}: BACKFILL ${this.method} → erp_raw.${table} ` +
        `(${window.field} ${window.from} .. ${window.to}) — ` +
        `re-reading a window; cursor, watermark and reconciliation untouched`,
    );

    try {
      for await (const { pageNo, rows } of this.erp.queryAll<Record<string, unknown>>(
        this.method,
        { conditions, orders: this.sweepOrder() },
      )) {
        pages++;
        const result = await this.raw.upsertMany(this.objectType, rows, (row) =>
          this.keyOf(row),
        );
        fetched += result.fetched;
        changed += result.changed;
        this.logger.log(
          `${this.name}: backfill page ${pageNo} — stored ${result.fetched} row(s) ` +
            `(${result.changed} new/changed) into erp_raw.${table}`,
        );
        await this.afterPage(rows);
      }

      await this.raw.finishRun(runId, { status: 'SUCCESS', fetched, changed });
      this.logger.log(
        `${this.name}: backfill done in ${Date.now() - startedAt}ms — ` +
          `${fetched} row(s) over ${pages} page(s), ${changed} new/changed`,
      );
      return { fetched, changed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.raw.finishRun(runId, { status: 'FAILED', fetched, changed, error: message });
      this.logger.error(`${this.name}: backfill FAILED — ${message}`);
      throw error;
    }
  }
}

/**
 * The ERP uses an all-zero GUID as "no value" on detail-line primary keys. It is
 * present and well-formed, so a plain `?? fallback` never fires — every
 * detail-less document then shares one key and collapses onto a single raw row.
 * Seen on both sales orders and deliveries.
 */
const ZERO_GUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

const usableId = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" && !ZERO_GUID.test(value) ? value : undefined;

/**
 * A stable key for a document LINE when the ERP exposes no line primary key.
 * Built from the line-specific (subtable) fields, so every distinct line of a
 * document is stored instead of the whole document collapsing to one row.
 *
 * ⚠️ Trade-off: editing a line changes its key, so the edited line arrives as a
 * new row and the previous version lingers. Lines that are byte-identical still
 * collapse — they carry no information to tell apart. Both go away if the ERP
 * exposes the subtable primary key (SALES_RETURN_D_ID), which its docs omit.
 */
const lineHash = (row: Record<string, unknown>, fields: readonly string[]): string =>
  createHash("sha1")
    .update(fields.map((f) => String(row[f] ?? "")).join(""))
    .digest("hex")
    .slice(0, 16);

@Injectable()
export class CustomerIngestJob extends IngestJob {
  readonly name = 'ingest:customer';
  protected readonly method = ERP_METHOD.CUSTOMER_QUERY;
  protected readonly objectType: ErpObjectType = 'CUSTOMER';

  protected keyOf(row: Record<string, unknown>) {
    return row.CUSTOMER_CODE as string | undefined;
  }

  /**
   * Customers are the only place both customer identifiers appear together, so
   * this is where the Guid→code bridge gets built. Orders and deliveries
   * reference CUSTOMER_ID (a Guid); Customer.erpId holds CUSTOMER_CODE. Without
   * recording the pair here, no order could ever find its customer.
   */
  protected async afterPage(page: Record<string, unknown>[]): Promise<void> {
    // One batched upsert for the whole page, not one round-trip per customer.
    const pairs = page
      .map((row) => ({
        guid: row.CUSTOMER_ID as string,
        code: row.CUSTOMER_CODE as string,
      }))
      .filter((x) => x.guid && x.code);
    await this.raw.linkCustomers(pairs);
  }
}

/**
 * Sales orders arrive as HEADER + ONE DETAIL LINE per row, flattened.
 *
 * The API doc's return-field table for sales_order_doc.query lists the detail
 * table's primary key (SALES_ORDER_DOC_D_ID) and SequenceNumber next to the
 * header fields, and its sample response shows them in one flat object — so a
 * five-line order comes back as five rows that all repeat the same DOC_NO.
 *
 * Keying on DOC_NO (as this job used to) therefore collapsed every order down to
 * a single line: within a page the dedupe map kept only the last line, and across
 * pages ON CONFLICT overwrote it. That silently discarded the per-product data,
 * and made the content hash flip on every sweep — so these rows were rewritten
 * every cycle instead of being skipped as unchanged.
 *
 * Keying on the detail-line id keeps every line. DOC_NO is still what the
 * projection groups by, and it reads it from the payload rather than the key.
 */
@Injectable()
export class SalesOrderIngestJob extends IngestJob {
  readonly name = 'ingest:sales_order';
  protected readonly method = ERP_METHOD.SALES_ORDER_QUERY;
  protected readonly objectType: ErpObjectType = 'SALES_ORDER';

  protected keyOf(row: Record<string, unknown>) {
    // Fall back to DOC_NO so a header-only response (no detail line) is still
    // ingested rather than dropped as un-keyable.
    // SALES_ORDER_DOC_D_ID alone is not enough, for two reasons in the live feed:
    //  1. Orders with no detail line carry the ZERO GUID, which every such order
    //     shares — they all collapsed onto one row. The old `?? DOC_NO` fallback
    //     never fired, because the field is present, just meaningless.
    //  2. A detail line can repeat, differing only in SequenceNumber1 (a
    //     delivery-schedule level below the line).
    const detailId = row.SALES_ORDER_DOC_D_ID as string | undefined;
    const base = usableId(detailId) ?? (row.DOC_NO as string | undefined);
    if (!base) return undefined;
    const subLine = row.SequenceNumber1;
    return subLine === undefined || subLine === null
      ? base
      : `${base}|${subLine}`;
  }
}

@Injectable()
export class CollectionIngestJob extends IngestJob {
  readonly name = 'ingest:collection';
  protected readonly method = ERP_METHOD.COLLECTION_QUERY;
  protected readonly objectType: ErpObjectType = 'COLLECTION';

  protected keyOf(row: Record<string, unknown>) {
    return row.DOC_NO as string | undefined;
  }
}

/**
 * Deliveries are not yet projected anywhere, but we ingest them because they are
 * the most likely real source of "loaded cartons" — today the app derives that
 * from its own LoadingRequest table, while SALES_DELIVERY is the ERP's record of
 * what actually left the warehouse. Capturing it now means the data is already
 * there when we decide to use it.
 */
@Injectable()
export class SalesDeliveryIngestJob extends IngestJob {
  readonly name = 'ingest:sales_delivery';
  protected readonly method = ERP_METHOD.SALES_DELIVERY_QUERY;
  protected readonly objectType: ErpObjectType = 'SALES_DELIVERY';

  /**
   * ⚠️ DOC_NO is NOT unique any more. The 2026-09-07 doc update added the
   * subtable to this query, so a delivery with N lines now arrives as N rows all
   * sharing one DOC_NO — keying on it kept a single line per delivery. Measured
   * live: 1,200 rows, only 275 distinct DOC_NO.
   *
   * SALES_DELIVERY_D_ID (the subtable primary key, new in the same update) is
   * unique except for detail-less deliveries, which carry the zero GUID and fall
   * back to the document number.
   */
  protected keyOf(row: Record<string, unknown>) {
    return usableId(row.SALES_DELIVERY_D_ID) ?? (row.DOC_NO as string | undefined);
  }
}

@Injectable()
export class CustomerCreditIngestJob extends IngestJob {
  readonly name = 'ingest:customer_credit';
  protected readonly method = ERP_METHOD.CUSTOMER_CREDIT_QUERY;
  protected readonly objectType: ErpObjectType = 'CUSTOMER_CREDIT';

  protected keyOf(row: Record<string, unknown>) {
    // CUSTOMER_CREDIT_ID is NOT unique: the ERP holds one row per credit PERIOD
    // and every period of a customer shares the same id, differing only by
    // EFFECTIVE_DATE. Measured live: 1,837 rows but 1,831 distinct ids, so
    // keying on the id alone silently dropped 6 records (customer 20410008
    // has two periods; we kept one). id + EFFECTIVE_DATE is unique across all.
    const id = row.CUSTOMER_CREDIT_ID as string | undefined;
    if (!id) return undefined;
    // CREDIT_AMT1 is part of the key because it is sometimes the ONLY thing
    // separating two genuinely different credit records. Customer 10110007
    // has two rows sharing an id AND an effective date, differing only in the
    // amount (100,000,000 vs 2,000) — the ERP team confirmed both are real.
    // Without it we silently kept one and dropped the other.
    //
    // ⚠️ It is a mutable field, so editing the amount produces a NEW key and
    // leaves the old row behind. That is survivable only because this object
    // sweeps in FULL every cycle (ERP_FULL_SWEEP_JOBS) and reconciliation then
    // deletes the row the ERP no longer returns. Do not add mutable fields to
    // a key on an object that sweeps incrementally.
    const effective = (row.EFFECTIVE_DATE as string | undefined) ?? '';
    const amount = row.CREDIT_AMT1 ?? '';
    return `${id}|${effective}|${amount}`;
  }
}

// The three below are dump-only (no projection yet): we capture every response
// so all endpoints land in their own table, ready if/when we need them.

@Injectable()
export class SalesReturnIngestJob extends IngestJob {
  readonly name = 'ingest:sales_return';
  protected readonly method = ERP_METHOD.SALES_RETURN_QUERY;
  protected readonly objectType: ErpObjectType = 'SALES_RETURN';

  /** The line-level (subtable) fields, per api_docs/sales_return.query.md. */
  private static readonly LINE_FIELDS = [
    'AMOUNT',
    'AMOUNT_UNINCLUDE_TAX_BC1',
    'AMOUNT_UNINCLUDE_TAX_OC1',
    'BUSINESS_QTY',
    'ITEM_DESCRIPTION',
    'ITEM_CODE',
    'ITEM_NAME',
    'LOT_CODE',
    'ITEM_SPECIFICATION',
    'ITEM_TYPE',
    'PIECES1',
    'PRICE',
    'PRICE_QTY',
    'REMARK1',
    'SALES_RETURN_TYPE',
    'TAX_BC1',
    'TAX_ID1',
    'TAX_OC1',
    'TAX_RATE',
    'WAREHOUSE_CODE',
    'WAREHOUSE_NAME',
  ] as const;

  /**
   * ⚠️ Like deliveries, returns now carry their lines — but unlike deliveries the
   * ERP exposes NO subtable primary key (the doc lists only SALES_RETURN_ID, the
   * header key). Keying on DOC_NO kept one line per return: 550 rows collapsed to
   * 241.
   *
   * So the key is the document number plus a hash of the line's own fields, which
   * preserves 520 of the 550. The 30 that still merge are byte-identical rows
   * with nothing to tell them apart. Ask the ERP for SALES_RETURN_D_ID and this
   * becomes a one-line change.
   */
  protected keyOf(row: Record<string, unknown>) {
    const docNo = row.DOC_NO as string | undefined;
    if (!docNo) return undefined;
    return `${docNo}|${lineHash(row, SalesReturnIngestJob.LINE_FIELDS)}`;
  }
}

@Injectable()
export class ArRefundIngestJob extends IngestJob {
  readonly name = 'ingest:ar_refund';
  protected readonly method = ERP_METHOD.AR_REFUND_QUERY;
  protected readonly objectType: ErpObjectType = 'AR_REFUND';

  protected keyOf(row: Record<string, unknown>) {
    return row.DOC_NO as string | undefined;
  }
}

@Injectable()
export class ArTransferIngestJob extends IngestJob {
  readonly name = 'ingest:ar_transfer';
  protected readonly method = ERP_METHOD.AR_TRANSFER_QUERY;
  protected readonly objectType: ErpObjectType = 'AR_TRANSFER';

  /** Header-only object: DOC_NO is unique across the feed (4,440 of 4,440). */
  protected keyOf(row: Record<string, unknown>) {
    return row.DOC_NO as string | undefined;
  }
}

@Injectable()
export class OtherReceivableIngestJob extends IngestJob {
  readonly name = 'ingest:other_receivable';
  protected readonly method = ERP_METHOD.OTHER_RECEIVABLE_QUERY;
  protected readonly objectType: ErpObjectType = 'OTHER_RECEIVABLE';

  protected keyOf(row: Record<string, unknown>) {
    return row.DOC_NO as string | undefined;
  }
}
