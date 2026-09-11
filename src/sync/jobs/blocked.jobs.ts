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
 * Sales-order line items exist, and the response shape is no longer in doubt:
 * api_docs/sales_order_doc.query.md lists the detail fields (SALES_ORDER_DOC_D_ID,
 * SequenceNumber, ITEM_ID, BUSINESS_QTY, ...) in the SAME table as the header
 * fields, and its sample response is one FLAT object per line. So a five-line
 * order arrives as five rows repeating one DOC_NO — which is exactly what the
 * ingest key (SALES_ORDER_DOC_D_ID) already accounts for.
 *
 * ⚠️ NEW FINDING (2026-08-23), measured against the live feed. The blocker is no
 * longer only ITEM_ID → product resolution. The feed has NO PER-LINE MONEY AT
 * ALL: AMT_UNINCLUDE_TAX_OC and TAX_OC are HEADER totals repeated verbatim on
 * every line of an order (0 of 5,000 sampled DOC_NOs carry more than one distinct
 * value across their lines), and there is no unit-price field anywhere on the
 * row. PurchaseItem.unitPrice and PurchaseItem.lineTotal are both NOT NULL, so
 * projecting lines today means writing zeros or apportioning the header total by
 * quantity — inventing prices — into a screen a distributor reads as an invoice.
 *
 * Quantity and description ARE available per line (BUSINESS_QTY,
 * ITEM_DESCRIPTION), so this becomes a small job the moment a price arrives.
 *
 * When it does, the write must be DELETE-then-INSERT inside the parent
 * Purchase's transaction, not an upsert: PurchaseItem has no natural key and no
 * unique constraint, so there is nothing to conflict-target, and re-inserting
 * without deleting is how you get a line duplicated on every sync. Deleting
 * first is also what makes a line REMOVED in the ERP disappear here.
 *
 * Until then nothing in this service writes public."PurchaseItem" — the seeded
 * and app-created rows that exist today are left strictly alone.
 */
@Injectable()
export class PurchaseItemProjectionJob extends BlockedJob {
  readonly name = 'project:purchase_item';
  protected readonly reason =
    'Sales-order line items are ingested and their shape is confirmed, but the ERP ' +
    'sends no per-line price or amount — AMT_UNINCLUDE_TAX_OC/TAX_OC are header ' +
    'totals repeated on every line. PurchaseItem.unitPrice and .lineTotal are NOT ' +
    'NULL, so projecting lines would mean fabricating the money on a customer-facing ' +
    'order. ITEM_ID also still has no material master to resolve against.';
  protected readonly unblockedBy =
    'A per-line amount or unit price on sales_order_doc.query (e.g. an AMT/PRICE ' +
    'field on the detail row). Once present, project with DELETE-then-INSERT of the ' +
    "purchase's items inside the parent's transaction — PurchaseItem has no unique " +
    'key to upsert on. The line data itself is already in erp_raw.raw_sales_order.';
}
