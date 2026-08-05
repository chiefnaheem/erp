import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, Region } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RawRepository } from '../../raw/raw.repository';
import {
  buildCustomerFieldMap,
  buildStatusMap,
  purchaseTotalItems,
  purchaseTotalValue,
  resolveCustomer,
  toDate,
  toNumber,
  toOrderStatus,
} from '../erp.mappers';
import { JobStats, SyncJob } from '../sync.job';

// How many pending rows to pull and write per batch while draining. Big enough to
// be efficient, small enough to keep each transaction/prisma round short.
const DEFAULT_BATCH = 1000;
// Runaway guard for the drain loop (rows / batch = max rows drained per run).
const MAX_BATCHES = 100_000;

/**
 * Projection = erp_raw → public.*
 *
 * Only rows whose content hash actually moved reach here (projected_at IS NULL),
 * so a steady-state sweep projects nothing and writes nothing to the app's tables.
 *
 * A row that cannot be mapped is NOT dropped: its project_error is recorded and
 * projected_at stays NULL, so it remains queued and heals itself the moment the
 * mapping gap is closed.
 */

@Injectable()
export class CustomerProjectionJob extends SyncJob {
  readonly name = 'project:customer';

  constructor(
    raw: RawRepository,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super(raw);
  }

  protected async execute(): Promise<JobStats> {
    // Set-based refresh of ERP-owned fields (name) on customers that already
    // exist — one statement, finishes instantly, so it never stalls the cycle
    // ahead of the purchase/payment projections.
    //
    // Customer CREATION is intentionally not attempted: the ERP's PhoneNumber is
    // a shared placeholder (thousands of customers share one number), and phone
    // is the unique login, so mass creation is impossible until the ERP supplies
    // real per-customer phones. UAT/onboarded customers are provisioned directly
    // with real phones; their transactions then project on the active-only path.
    const { updated } = await this.raw.bulkRefreshCustomers();
    return { projected: updated };
  }
}

@Injectable()
export class PurchaseProjectionJob extends SyncJob {
  readonly name = 'project:purchase';

  constructor(
    raw: RawRepository,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super(raw);
  }

  protected async execute(): Promise<JobStats> {
    const statusMap = buildStatusMap(this.config.get<string>('ERP_STATUS_MAP'));

    // Set-based bulk projection: every active customer's unprojected orders are
    // written in ONE statement, so a full cycle finishes in seconds instead of the
    // per-row loop that never completed within the lock lease. Only active
    // customers' orders are touched (transactions-on-demand scope), and only those
    // whose ApproveStatus is mapped — the rest stay queued.
    const { projected } = await this.raw.bulkProjectPurchases(statusMap);
    return { projected };
  }
}

/**
 * Collections → public.Payment.
 *
 * Unblocked by the 2026-07-28 ERP update: collection_doc.query now returns
 * CUSTOMER_CODE, so a payment can finally be attributed to a customer (that was
 * the whole blocker — Payment.customerId is a required FK).
 *
 * runningBalance has no ERP source and is a required column, so it is written as
 * 0 for now (a placeholder, not a real ledger balance — see erp-reconciliation).
 */
@Injectable()
export class PaymentProjectionJob extends SyncJob {
  readonly name = 'project:payment';

  constructor(
    raw: RawRepository,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super(raw);
  }

  protected async execute(): Promise<JobStats> {
    // Set-based bulk projection of active customers' collections in one statement
    // (see PurchaseProjectionJob) so the cycle completes within the lock lease.
    const { projected } = await this.raw.bulkProjectPayments();
    return { projected };
  }
}
