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
    const fieldMap = buildCustomerFieldMap({
      phoneField: this.config.get<string>('ERP_CUSTOMER_PHONE_FIELD'),
      regionField: this.config.get<string>('ERP_CUSTOMER_REGION_FIELD'),
      regionMap: this.config.get<string>('ERP_REGION_MAP'),
      regionDefault: this.config.get<string>('ERP_REGION_DEFAULT'),
    });
    const batchSize = this.config.get<number>('ERP_PROJECT_BATCH') ?? DEFAULT_BATCH;

    let projected = 0;
    let skipped = 0;
    let created = 0;
    const unmappedRegions = new Set<string>();

    // ALL customers project (login/lookup base). Bulk-write per batch — a few
    // set queries + one createMany per batch instead of ~3 round-trips per row,
    // so thousands of customers project in seconds, not the ~28 min that blew
    // past the lock lease.
    let afterId = 0n;
    for (let b = 0; b < MAX_BATCHES; b++) {
      const batch = await this.raw.pendingProjection('CUSTOMER', afterId, batchSize);
      if (batch.length === 0) break;
      afterId = batch[batch.length - 1].id;

      // Resolve, and dedupe by phone within the batch (unique constraint).
      const seenPhone = new Set<string>();
      const creatable: {
        rawId: bigint;
        erpId: string;
        name: string;
        phone: string;
        region: Region;
      }[] = [];
      const failed: bigint[] = [];

      for (const record of batch) {
        const r = resolveCustomer(record.payload, fieldMap);
        if (!r.name || !r.phone || !r.region) {
          if (r.phone && r.rawRegion && !r.region) unmappedRegions.add(r.rawRegion);
          failed.push(record.id);
          await this.raw.markProjectFailed(
            'CUSTOMER',
            record.id,
            !r.name ? 'no name' : !r.phone ? 'no phone' : 'no region',
          );
          continue;
        }
        if (seenPhone.has(r.phone)) {
          // Two ERP customers share a phone in this batch — defer the dup; it
          // retries next run once the first is committed.
          failed.push(record.id);
          await this.raw.markProjectFailed('CUSTOMER', record.id, `duplicate phone in batch: ${r.phone}`);
          continue;
        }
        seenPhone.add(r.phone);
        creatable.push({ rawId: record.id, erpId: record.erp_key, name: r.name, phone: r.phone, region: r.region });
      }
      skipped += failed.length;

      if (creatable.length === 0) continue;

      // Which of these already exist (by erpId or by phone), in one query each.
      const erpIds = creatable.map((c) => c.erpId);
      const phones = creatable.map((c) => c.phone);
      const [byErp, byPhone] = await Promise.all([
        this.prisma.customer.findMany({
          where: { erpId: { in: erpIds } },
          select: { id: true, erpId: true },
        }),
        this.prisma.customer.findMany({
          where: { phone: { in: phones } },
          select: { id: true, erpId: true, phone: true },
        }),
      ]);
      const existErpId = new Map(byErp.map((c) => [c.erpId, c.id]));
      const phoneOwner = new Map(byPhone.map((c) => [c.phone!, c] as const));

      const toCreate: typeof creatable = [];
      const projectedIds: bigint[] = [];

      for (const c of creatable) {
        const existingId = existErpId.get(c.erpId);
        if (existingId) {
          // Update ONLY the name on an existing customer. phone and region are
          // app-owned identity/login fields — and the ERP's phone is a shared
          // placeholder — so the sync must never overwrite them once set.
          await this.prisma.customer.update({
            where: { id: existingId },
            data: { name: c.name },
          });
          projectedIds.push(c.rawId);
          projected++;
          continue;
        }
        const owner = phoneOwner.get(c.phone);
        if (owner && owner.erpId !== c.erpId) {
          // Phone already belongs to another customer (onboarded before the ERP
          // link). Attach this erpId to them rather than creating a duplicate.
          await this.prisma.customer.update({
            where: { id: owner.id },
            data: { erpId: c.erpId, name: c.name, region: c.region },
          });
          projectedIds.push(c.rawId);
          projected++;
          continue;
        }
        toCreate.push(c);
      }

      if (toCreate.length) {
        await this.prisma.customer.createMany({
          data: toCreate.map((c) => ({
            erpId: c.erpId,
            name: c.name,
            phone: c.phone,
            region: c.region,
          })),
          skipDuplicates: true,
        });
        for (const c of toCreate) projectedIds.push(c.rawId);
        created += toCreate.length;
        projected += toCreate.length;
      }

      await this.raw.markProjected('CUSTOMER', projectedIds);
    }

    if (created) this.logger.log(`created ${created} new customer(s) from ERP`);
    if (unmappedRegions.size) {
      this.logger.error(
        `Unmapped ERP Region values (add to ERP_REGION_MAP or set ERP_REGION_DEFAULT): ` +
          `${[...unmappedRegions].join(', ')}`,
      );
    }

    return { projected, skipped };
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
    const batchSize = this.config.get<number>('ERP_PROJECT_BATCH') ?? DEFAULT_BATCH;

    let projected = 0;
    let skipped = 0;
    const unmappedStatuses = new Set<string>();

    // ONLY active customers' orders are projected (transactions-on-demand scope).
    // pendingProjectionActive joins to public.Customer WHERE password IS NOT NULL,
    // so a non-onboarded customer's orders are never even fetched — they stay
    // queued and project themselves the moment that customer onboards.
    let afterId = 0n;
    for (let b = 0; b < MAX_BATCHES; b++) {
      const batch = await this.raw.pendingProjectionActive('SALES_ORDER', afterId, batchSize);
      if (batch.length === 0) break;
      afterId = batch[batch.length - 1].id;
      const done: bigint[] = [];

      for (const record of batch) {
        const payload = record.payload;

        // The active join guarantees the customer exists and is onboarded, but we
        // still resolve its id via the guid → code bridge.
        const guid = payload.CUSTOMER_ID as string | undefined;
        const code = guid ? await this.raw.resolveCustomerCode(guid) : null;
        const customer = code
          ? await this.prisma.customer.findUnique({
              where: { erpId: code },
              select: { id: true },
            })
          : null;
        if (!customer) {
          skipped++;
          await this.raw.markProjectFailed(
            'SALES_ORDER',
            record.id,
            `Could not resolve customer for order (CUSTOMER_ID ${guid ?? 'missing'})`,
          );
          continue;
        }

        // ⚠️ An unmapped ApproveStatus is skipped, not guessed — a wrong order
        // status is worse than none. Stays queued until ERP_STATUS_MAP is set.
        const status = toOrderStatus(payload.ApproveStatus, statusMap);
        if (!status) {
          skipped++;
          unmappedStatuses.add(String(payload.ApproveStatus));
          await this.raw.markProjectFailed(
            'SALES_ORDER',
            record.id,
            `Unmapped ApproveStatus "${String(payload.ApproveStatus)}" — add it to ERP_STATUS_MAP`,
          );
          continue;
        }

        const orderDate = toDate(payload.ORDER_DATE) ?? toDate(payload.DOC_DATE);
        if (!orderDate) {
          skipped++;
          await this.raw.markProjectFailed('SALES_ORDER', record.id, 'ERP order has no usable date');
          continue;
        }

        const totalValue = purchaseTotalValue(payload);
        if (totalValue === null) {
          skipped++;
          await this.raw.markProjectFailed(
            'SALES_ORDER',
            record.id,
            'ERP order has no AMT_UNINCLUDE_TAX_OC',
          );
          continue;
        }

        // Header only. PurchaseItem is projected by its own job once the line-item
        // response shape is confirmed — not wiped here.
        await this.prisma.purchase.upsert({
          where: { erpId: record.erp_key },
          update: {
            status,
            orderDate,
            totalItems: purchaseTotalItems(payload),
            totalValue,
          },
          create: {
            erpId: record.erp_key,
            customerId: customer.id,
            status,
            orderDate,
            totalItems: purchaseTotalItems(payload),
            totalValue,
          },
        });

        done.push(record.id);
        projected++;
      }

      await this.raw.markProjected('SALES_ORDER', done);
    }

    if (unmappedStatuses.size) {
      this.logger.error(
        `Unmapped ApproveStatus values seen: ${[...unmappedStatuses].join(', ')}. ` +
          `Set ERP_STATUS_MAP, e.g. ERP_STATUS_MAP={"${[...unmappedStatuses][0]}":"${OrderStatus.PROCESSING}"}`,
      );
    }

    return { projected, skipped };
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
    const batchSize = this.config.get<number>('ERP_PROJECT_BATCH') ?? DEFAULT_BATCH;

    let projected = 0;
    let skipped = 0;

    // Only active customers' payments (transactions-on-demand). The active join
    // matches collection CUSTOMER_CODE to an onboarded public.Customer.
    let afterId = 0n;
    for (let b = 0; b < MAX_BATCHES; b++) {
      const batch = await this.raw.pendingProjectionActive('COLLECTION', afterId, batchSize);
      if (batch.length === 0) break;
      afterId = batch[batch.length - 1].id;
      const done: bigint[] = [];

      for (const record of batch) {
        const payload = record.payload;
        const code = payload.CUSTOMER_CODE as string | undefined;
        const customer = code
          ? await this.prisma.customer.findUnique({
              where: { erpId: code },
              select: { id: true },
            })
          : null;
        if (!customer) {
          skipped++;
          await this.raw.markProjectFailed(
            'COLLECTION',
            record.id,
            `Could not resolve customer for payment (CUSTOMER_CODE ${code ?? 'missing'})`,
          );
          continue;
        }

        const date = toDate(payload.DOC_DATE);
        const amount = toNumber(payload.COLLECTION_AMT_TC);
        if (!date || amount === null) {
          skipped++;
          await this.raw.markProjectFailed(
            'COLLECTION',
            record.id,
            'Collection missing DOC_DATE or COLLECTION_AMT_TC',
          );
          continue;
        }

        await this.prisma.payment.upsert({
          where: { erpId: record.erp_key },
          update: { customerId: customer.id, date, amount, reference: record.erp_key },
          create: {
            erpId: record.erp_key,
            customerId: customer.id,
            date,
            amount,
            reference: record.erp_key,
            runningBalance: 0, // no ERP source; placeholder
          },
        });

        done.push(record.id);
        projected++;
      }

      await this.raw.markProjected('COLLECTION', done);
    }

    return { projected, skipped };
  }
}
