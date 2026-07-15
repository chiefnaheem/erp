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
 * The single most damaging gap: sales_order_doc.query returns header fields only.
 */
@Injectable()
export class PurchaseItemProjectionJob extends BlockedJob {
  readonly name = 'project:purchase_item';
  protected readonly reason =
    'The ERP exposes no sales-order LINE ITEMS — only order headers. So ' +
    'public.PurchaseItem (productName, quantity, unitPrice, lineTotal) has no source, ' +
    'and the per-product Stock Balance Breakdown has no data behind it.';
  protected readonly unblockedBy =
    'Confirmation that sales_order_doc.read returns detail lines, or a ' +
    'sales_order_detail method. Run `npm run probe` (check 3) to find out.';
}

/**
 * COLLECTION_DOC carries SETTLEMENT_OBJECT_TYPE but no CUSTOMER_ID, and
 * Payment.customerId is a required FK — an unattributable payment is useless.
 */
@Injectable()
export class PaymentProjectionJob extends BlockedJob {
  readonly name = 'project:payment';
  protected readonly reason =
    'COLLECTION_DOC has no customer field, so a payment cannot be attributed to a ' +
    'customer — and Payment.customerId is a required FK. (runningBalance is also absent.)';
  protected readonly unblockedBy =
    'A customer identifier on the collection document, or confirmation that the ' +
    'customer sits on its lines. Run `npm run probe` (check 5).';
}
