import { Injectable } from '@nestjs/common';
import { JobStats, SyncJob } from '../sync.job';

/**
 * Jobs that CANNOT be built because the ERP does not expose the data.
 *
 * They exist as explicit, registered no-ops rather than being quietly omitted.
 * A missing job is invisible; a job that announces "I am blocked, and here is
 * exactly why" is a standing reminder that a feature has no data behind it, and
 * it records that fact in erp_raw.sync_run alongside the jobs that do work.
 *
 * Each one becomes real the moment the corresponding gap in CONTRACT.md closes.
 */
// @Injectable() is required so the subclasses inherit constructor DI metadata.
@Injectable()
abstract class BlockedJob extends SyncJob {
  protected abstract readonly reason: string;
  protected abstract readonly unblockedBy: string;

  protected async execute(): Promise<JobStats> {
    this.logger.warn(`${this.name} SKIPPED — ${this.reason}`);
    this.logger.warn(`  unblocked by: ${this.unblockedBy}`);
    return { skipped: 1 };
  }
}

/**
 * There is no product, material, item, inventory, or stock method anywhere in the
 * ERP API index — the eight objects it exposes are all documents plus customer
 * and customer-credit.
 */
@Injectable()
export class StockProjectionJob extends BlockedJob {
  readonly name = 'project:stock';
  protected readonly reason =
    'The ERP exposes NO product/inventory endpoint at all. public.Stock, ' +
    'GET /officers/stock and the LOW_STOCK/OUT_OF_STOCK status have no ERP source.';
  protected readonly unblockedBy =
    'An ERP method returning the material master (product code + name) and on-hand ' +
    'quantity. Until then, stock comes only from the main API\'s POST /erp/sync/stock webhook.';
}

/**
 * The 2026-07-28 ERP update DID add sales-order line items (ITEM_ID,
 * ITEM_DESCRIPTION, BUSINESS_QTY, ...), so this is now buildable — but HOW the
 * lines are nested in sales_order_doc.query is not specified in the docs, and it
 * matters: if the response returns one flat row per line (header repeated), the
 * sales_order ingest key (DOC_NO) collides and we'd keep only one line per order.
 * Confirm the shape against a live response before wiring the projection.
 */
@Injectable()
export class PurchaseItemProjectionJob extends BlockedJob {
  readonly name = 'project:purchase_item';
  protected readonly reason =
    'Sales-order line items now EXIST in the ERP (2026-07-28 update), but the ' +
    'response nesting (detail array vs one flat row per line) is unconfirmed, and ' +
    'it changes the ingest key. Not wired until a live sample confirms the shape.';
  protected readonly unblockedBy =
    'One live sales_order_doc.query sample showing how line items are nested. ' +
    'The startup debug probe now logs nested arrays/keys — restart and check its ' +
    'sales_order output.';
}
