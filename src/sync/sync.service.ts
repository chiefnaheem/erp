import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PurchaseItemProjectionJob,
  StockProjectionJob,
} from './jobs/blocked.jobs';
import {
  ArRefundIngestJob,
  CollectionIngestJob,
  CustomerCreditIngestJob,
  CustomerCreditLineIngestJob,
  CustomerIngestJob,
  OtherReceivableIngestJob,
  SalesDeliveryIngestJob,
  SalesOrderIngestJob,
  SalesReturnIngestJob,
} from './jobs/ingest.jobs';
import {
  CustomerProjectionJob,
  PaymentProjectionJob,
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
    private readonly customerCreditLineIngest: CustomerCreditLineIngestJob,
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
  private async runJobs(
    label: string,
    jobs: SyncJob[],
    concurrency: number,
  ): Promise<void> {
    if (!this.config.get<boolean>('SYNC_ENABLED')) {
      this.logger.warn(`SYNC_ENABLED=false — skipping ${label}`);
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

    // Bounded concurrency: at most `concurrency` jobs run at once. All-8-at-once
    // was overloading the flaky DB into half-open hangs; a smaller window keeps
    // each sweep likelier to complete. concurrency=1 is sequential.
    const limit = Math.max(1, Math.min(concurrency, jobs.length));
    this.logger.log(`${label}: running ${jobs.length} job(s), ${limit} at a time`);
    const queue = [...jobs];
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        await runJob(job);
      }
    };
    await Promise.all(Array.from({ length: limit }, worker));

    const summary = `${label} finished in ${Date.now() - startedAt}ms — ${
      jobs.length - failures.length
    }/${jobs.length} ok`;
    if (failures.length) this.logger.error(`${summary}; FAILED: ${failures.join(', ')}`);
    else this.logger.log(summary);
  }

  /**
   * INGEST: ERP → erp_raw. All objects are independent, so they run concurrently.
   * This is the heavy, slow half (full sweeps of hundreds of thousands of rows).
   */
  async runIngest(): Promise<void> {
    await this.runJobs(
      'ingest',
      [
        this.customerIngest, // builds customer_link, needed by projection
        this.salesOrderIngest,
        this.collectionIngest,
        this.salesDeliveryIngest,
        this.customerCreditIngest,
        this.customerCreditLineIngest,
        this.salesReturnIngest,
        this.arRefundIngest,
        this.otherReceivableIngest,
      ],
      // Bounded concurrency (default 3) so the big sweeps don't overload the DB.
      this.config.get<number>('ERP_INGEST_CONCURRENCY') ?? 3,
    );
  }

  /**
   * PROJECT: erp_raw → public.*. Decoupled from ingest and run on its own, more
   * frequent schedule, so it drains the backlog independently instead of waiting
   * on (and dying with) the slow sweep. Sequential + dependency-ordered:
   * customers must exist before their orders/payments (FK).
   */
  async runProjection(): Promise<void> {
    await this.runJobs(
      'projection',
      [
        this.customerProjection, // all customers
        this.purchaseProjection, // active customers' orders
        this.paymentProjection, // active customers' payments
        // Blocked no-ops, registered so their absence stays visible.
        this.stockProjection,
        this.purchaseItemProjection,
      ],
      1, // sequential — customers must exist before their orders/payments (FK)
    );
  }
}
