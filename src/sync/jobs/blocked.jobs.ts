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
 * What remains is not a question about the ERP but work on our side: mapping
 * ITEM_ID onto a product we hold, which needs the (still missing) material
 * master, and writing the PurchaseItem rows.
 */
@Injectable()
export class PurchaseItemProjectionJob extends BlockedJob {
  readonly name = 'project:purchase_item';
  protected readonly reason =
    'Sales-order line items are ingested and their shape is confirmed by the API ' +
    'docs (one flat row per line, keyed on SALES_ORDER_DOC_D_ID), but the ' +
    'projection into public.PurchaseItem is not written yet: ITEM_ID cannot be ' +
    'resolved to a product without a material-master endpoint.';
  protected readonly unblockedBy =
    'Either an ERP method returning the material master (so ITEM_ID resolves to a ' +
    'product), or a decision to store the raw ITEM_ID/ITEM_DESCRIPTION as-is on ' +
    'PurchaseItem. The line data itself is already in erp_raw.raw_sales_order.';
}
