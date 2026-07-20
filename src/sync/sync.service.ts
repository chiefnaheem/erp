import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PaymentProjectionJob,
  PurchaseItemProjectionJob,
  StockProjectionJob,
} from './jobs/blocked.jobs';
import {
  ArRefundIngestJob,
  CollectionIngestJob,
  CustomerCreditIngestJob,
  CustomerIngestJob,
  OtherReceivableIngestJob,
  SalesDeliveryIngestJob,
  SalesOrderIngestJob,
  SalesReturnIngestJob,
} from './jobs/ingest.jobs';
import {
  CustomerProjectionJob,
  PurchaseProjectionJob,
} from './jobs/projection.jobs';
import { SyncJob } from './sync.job';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly customerIngest: CustomerIngestJob,
    private readonly salesOrderIngest: SalesOrderIngestJob,
    private readonly collectionIngest: CollectionIngestJob,
    private readonly salesDeliveryIngest: SalesDeliveryIngestJob,
    private readonly customerCreditIngest: CustomerCreditIngestJob,
    private readonly salesReturnIngest: SalesReturnIngestJob,
    private readonly arRefundIngest: ArRefundIngestJob,
    private readonly otherReceivableIngest: OtherReceivableIngestJob,
    private readonly customerProjection: CustomerProjectionJob,
    private readonly purchaseProjection: PurchaseProjectionJob,
    private readonly stockProjection: StockProjectionJob,
    private readonly purchaseItemProjection: PurchaseItemProjectionJob,
    private readonly paymentProjection: PaymentProjectionJob,
  ) {}

  /**
   * One full cycle.
   *
   * The order is not cosmetic — it is forced by the data:
   *
   *   1. Ingest customers FIRST. It is the only object carrying both CUSTOMER_ID
   *      (Guid) and CUSTOMER_CODE, so it is what populates customer_link. Without
   *      it, no sales order can resolve its customer and every purchase is skipped.
   *   2. Ingest the documents.
   *   3. Project customers before purchases — Purchase.customerId is a required FK.
   *
   * Jobs run sequentially. A failure is logged and the cycle CONTINUES: one dead
   * ERP object must not cost us the others, and every job is independently
   * retryable because its writes are idempotent upserts.
   */
  async runCycle(): Promise<void> {
    if (!this.config.get<boolean>('SYNC_ENABLED')) {
      this.logger.warn('SYNC_ENABLED=false — skipping cycle');
      return;
    }

    const ordered: SyncJob[] = [
      // ── Ingest: ERP → erp_raw ──
      this.customerIngest, // must be first: builds customer_link
      this.salesOrderIngest,
      this.collectionIngest,
      this.salesDeliveryIngest,
      this.customerCreditIngest,
      this.salesReturnIngest,
      this.arRefundIngest,
      this.otherReceivableIngest,

      // ── Project: erp_raw → public ──
      this.customerProjection, // must precede purchases (FK)
      this.purchaseProjection,

      // ── Blocked: registered so their absence is visible, not silent ──
      this.stockProjection,
      this.purchaseItemProjection,
      this.paymentProjection,
    ];

    const startedAt = Date.now();
    const failures: string[] = [];

    for (const job of ordered) {
      try {
        await job.run();
      } catch (error) {
        // Log here by name, and never assume SyncJob.run() managed to record the
        // failure itself. If a job blows up before/inside its own bookkeeping,
        // that write fails too — and the error would otherwise vanish without a
        // single line anywhere. A silently missing job is far worse than a noisy one.
        failures.push(job.name);
        this.logger.error(
          `job ${job.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const summary =
      `cycle finished in ${Date.now() - startedAt}ms — ` +
      `${ordered.length - failures.length}/${ordered.length} jobs ok`;

    if (failures.length) {
      this.logger.error(`${summary}; FAILED: ${failures.join(', ')}`);
    } else {
      this.logger.log(summary);
    }
  }
}
