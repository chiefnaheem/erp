import { Injectable } from '@nestjs/common';
import { ErpClient } from '../../erp/erp.client';
import { ERP_METHOD, ErpMethod } from '../../erp/erp.types';
import { ErpObjectType, RawRepository } from '../../raw/raw.repository';
import { JobStats, SyncJob } from '../sync.job';

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
  ) {
    super(raw);
  }

  protected async execute(): Promise<JobStats> {
    let fetched = 0;
    let changed = 0;
    let pageNo = 0;

    const table = this.raw.tableFor(this.objectType);
    this.logger.log(
      `${this.name}: sweeping ${this.method} → dumping into erp_raw.${table}`,
    );

    // The ERP has no delta support, so this is a FULL sweep every cycle. We page
    // through and hash rather than hold the whole table in memory — content
    // hashing is what keeps the cost of re-reading everything acceptable.
    for await (const page of this.erp.queryAll<Record<string, unknown>>(this.method)) {
      pageNo++;
      const result = await this.raw.upsertMany(this.objectType, page, (row) =>
        this.keyOf(row),
      );
      fetched += result.fetched;
      changed += result.changed;

      // Per-page storage line so each endpoint's fetch→store is visible: how many
      // rows this page had, how many were new/changed, and where they landed.
      this.logger.log(
        `${this.name}: page ${pageNo} — stored ${result.fetched} row(s) ` +
          `(${result.changed} new/changed) into erp_raw.${table}`,
      );

      await this.afterPage(page);
    }

    if (pageNo === 0) {
      this.logger.log(`${this.name}: ${this.method} returned no rows`);
    } else {
      this.logger.log(
        `${this.name}: done — ${fetched} row(s) total, ${changed} new/changed, ` +
          `across ${pageNo} page(s) into erp_raw.${table}`,
      );
    }

    return { fetched, changed };
  }

  /** Hook for per-page side effects (e.g. maintaining the customer Guid bridge). */
  protected async afterPage(_page: Record<string, unknown>[]): Promise<void> {}
}

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
    for (const row of page) {
      const guid = row.CUSTOMER_ID as string | undefined;
      const code = row.CUSTOMER_CODE as string | undefined;
      if (guid && code) await this.raw.linkCustomer(guid, code);
    }
  }
}

@Injectable()
export class SalesOrderIngestJob extends IngestJob {
  readonly name = 'ingest:sales_order';
  protected readonly method = ERP_METHOD.SALES_ORDER_QUERY;
  protected readonly objectType: ErpObjectType = 'SALES_ORDER';

  protected keyOf(row: Record<string, unknown>) {
    return row.DOC_NO as string | undefined;
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

  protected keyOf(row: Record<string, unknown>) {
    return row.DOC_NO as string | undefined;
  }
}

/** Candidate source for Customer.outstandingBalance (CREDIT_PAY). Unconfirmed. */
@Injectable()
export class CustomerCreditIngestJob extends IngestJob {
  readonly name = 'ingest:customer_credit';
  protected readonly method = ERP_METHOD.CUSTOMER_CREDIT_QUERY;
  protected readonly objectType: ErpObjectType = 'CUSTOMER_CREDIT';

  protected keyOf(row: Record<string, unknown>) {
    return row.CUSTOMER_CREDIT_ID as string | undefined;
  }
}

// The three below are dump-only (no projection yet): we capture every response
// so all endpoints land in their own table, ready if/when we need them.

@Injectable()
export class SalesReturnIngestJob extends IngestJob {
  readonly name = 'ingest:sales_return';
  protected readonly method = ERP_METHOD.SALES_RETURN_QUERY;
  protected readonly objectType: ErpObjectType = 'SALES_RETURN';

  protected keyOf(row: Record<string, unknown>) {
    return row.DOC_NO as string | undefined;
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
export class OtherReceivableIngestJob extends IngestJob {
  readonly name = 'ingest:other_receivable';
  protected readonly method = ERP_METHOD.OTHER_RECEIVABLE_QUERY;
  protected readonly objectType: ErpObjectType = 'OTHER_RECEIVABLE';

  protected keyOf(row: Record<string, unknown>) {
    return row.DOC_NO as string | undefined;
  }
}
