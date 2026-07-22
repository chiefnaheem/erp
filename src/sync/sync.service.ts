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
   * One full cycle, in two phases:
   *
   *   1. INGEST (ERP → erp_raw): all objects are independent — each hits a
   *      different endpoint and writes a different table — so they run CONCURRENTLY.
   *      No object waits on another, and one slow/dead endpoint no longer starves
   *      the rest (which is what previously left customer_credit / sales_return /
   *      ar_refund / other_receivable empty). customer ingest also builds
   *      customer_link here, which the purchase projection needs later.
   *   2. PROJECT (erp_raw → public): runs only AFTER all ingest completes, and
   *      stays sequential in dependency order — customers before purchases, since
   *      Purchase.customerId is a required FK.
   *
   * A failed job is logged and never aborts the others; every write is an
   * idempotent upsert, so any job is safely retried next cycle.
   */
  async runCycle(): Promise<void> {
    if (!this.config.get<boolean>('SYNC_ENABLED')) {
      this.logger.warn('SYNC_ENABLED=false — skipping cycle');
      return;
    }

    const startedAt = Date.now();
    const failures: string[] = [];

    const runJob = async (job: SyncJob) => {
      try {
        await job.run();
      } catch (error) {
        // Never assume SyncJob.run() recorded its own failure — if it blew up
        // before/inside its bookkeeping, the error would otherwise vanish.
        failures.push(job.name);
        this.logger.error(
          `job ${job.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    // ── Phase 1: ingest — all in parallel ──
    const ingestJobs: SyncJob[] = [
      this.customerIngest, // builds customer_link (needed by projection, phase 2)
      this.salesOrderIngest,
      this.collectionIngest,
      this.salesDeliveryIngest,
      this.customerCreditIngest,
      this.salesReturnIngest,
      this.arRefundIngest,
      this.otherReceivableIngest,
    ];
    this.logger.log(`ingest phase: running ${ingestJobs.length} jobs in parallel`);
    await Promise.all(ingestJobs.map(runJob));

    // ── Phase 2: project — sequential, dependency order (customers before purchases) ──
    const projectionJobs: SyncJob[] = [
      this.customerProjection,
      this.purchaseProjection,
      // Blocked no-ops, registered so their absence stays visible.
      this.stockProjection,
      this.purchaseItemProjection,
      this.paymentProjection,
    ];
    for (const job of projectionJobs) {
      await runJob(job);
    }

    const total = ingestJobs.length + projectionJobs.length;
    const summary =
      `cycle finished in ${Date.now() - startedAt}ms — ` +
      `${total - failures.length}/${total} jobs ok`;

    if (failures.length) {
      this.logger.error(`${summary}; FAILED: ${failures.join(', ')}`);
    } else {
      this.logger.log(summary);
    }
  }
}
