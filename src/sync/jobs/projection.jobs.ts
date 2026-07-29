import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '@prisma/client';
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
    const pending = await this.raw.pendingProjection('CUSTOMER');

    // Where phone/region live in the ERP payload is configurable, because the
    // documented customer schema doesn't include them — the probe finds the real
    // fields and we name them here. Until a phone field is configured, this job
    // stays UPDATE-ONLY: it refreshes existing customers but never inserts.
    const fieldMap = buildCustomerFieldMap({
      phoneField: this.config.get<string>('ERP_CUSTOMER_PHONE_FIELD'),
      regionField: this.config.get<string>('ERP_CUSTOMER_REGION_FIELD'),
      regionMap: this.config.get<string>('ERP_REGION_MAP'),
    });

    let projected = 0;
    let skipped = 0;
    let created = 0;
    const done: bigint[] = [];
    // Collected so one live run tells us the ERP's actual region strings, the way
    // we did for ApproveStatus.
    const unmappedRegions = new Set<string>();

    for (const record of pending) {
      const resolved = resolveCustomer(record.payload, fieldMap);

      if (!resolved.name) {
        skipped++;
        await this.raw.markProjectFailed('CUSTOMER', record.id, 'ERP row has no customer name');
        continue;
      }

      const existing = await this.prisma.customer.findUnique({
        where: { erpId: record.erp_key },
        select: { id: true },
      });

      if (existing) {
        // Update the ERP-owned fields on an existing customer. App-owned fields
        // (password, OTP state, assignedOfficer, ...) are never touched, and we
        // only overwrite phone/region when the ERP actually gave us usable values.
        await this.prisma.customer.update({
          where: { id: existing.id },
          data: {
            name: resolved.name,
            ...(resolved.phone ? { phone: resolved.phone } : {}),
            ...(resolved.region ? { region: resolved.region } : {}),
          },
        });
        done.push(record.id);
        projected++;
        continue;
      }

      // ── Customer does not exist yet: create it ──
      // Both phone and region are required (no schema default). If either is
      // missing or unmapped, skip and leave queued so it heals once the data or
      // the region map is fixed.
      if (!resolved.phone || !resolved.region) {
        skipped++;
        if (resolved.phone && resolved.rawRegion && !resolved.region) {
          // We got a region string from the ERP but couldn't map it to our enum.
          unmappedRegions.add(resolved.rawRegion);
        }
        const missing = !resolved.phone
          ? 'phone (PhoneNumber empty)'
          : resolved.rawRegion
            ? `region — unmapped ERP value "${resolved.rawRegion}"`
            : 'region (Region empty)';
        await this.raw.markProjectFailed(
          'CUSTOMER',
          record.id,
          `Cannot create customer ${record.erp_key}: ${missing}`,
        );
        continue;
      }

      // Guard the UNIQUE phone constraint: a customer may already exist under
      // this phone (onboarded before the ERP link). Attach the erpId instead of
      // failing the whole batch on a duplicate-key error.
      const byPhone = await this.prisma.customer.findUnique({
        where: { phone: resolved.phone },
        select: { id: true, erpId: true },
      });
      if (byPhone) {
        await this.prisma.customer.update({
          where: { id: byPhone.id },
          data: { erpId: record.erp_key, name: resolved.name, region: resolved.region },
        });
        done.push(record.id);
        projected++;
        continue;
      }

      await this.prisma.customer.create({
        data: {
          erpId: record.erp_key,
          name: resolved.name,
          phone: resolved.phone,
          region: resolved.region,
        },
      });
      done.push(record.id);
      created++;
      projected++;
    }

    await this.raw.markProjected('CUSTOMER', done);

    if (created) this.logger.log(`created ${created} new customer(s) from ERP`);
    if (unmappedRegions.size) {
      this.logger.error(
        `Unmapped ERP Region values (add them to ERP_REGION_MAP): ${[...unmappedRegions].join(', ')}. ` +
          `Example: ERP_REGION_MAP={"${[...unmappedRegions][0]}":"LAGOS"}`,
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
    const pending = await this.raw.pendingProjection('SALES_ORDER');
    const statusMap = buildStatusMap(this.config.get<string>('ERP_STATUS_MAP'));

    let projected = 0;
    let skipped = 0;
    const done: bigint[] = [];
    // Collected so one live run tells us exactly what ApproveStatus values exist.
    const unmappedStatuses = new Set<string>();

    for (const record of pending) {
      const payload = record.payload;

      // Sales orders reference the customer by Guid, but Customer.erpId holds the
      // CUSTOMER_CODE — resolve through the bridge the customer ingest builds.
      const guid = payload.CUSTOMER_ID as string | undefined;
      if (!guid) {
        skipped++;
        await this.raw.markProjectFailed('SALES_ORDER', record.id, 'ERP order has no CUSTOMER_ID');
        continue;
      }

      const code = await this.raw.resolveCustomerCode(guid);
      if (!code) {
        skipped++;
        await this.raw.markProjectFailed(
          'SALES_ORDER',
          record.id,
          `CUSTOMER_ID ${guid} not in customer_link — run ingest:customer first`,
        );
        continue;
      }

      const customer = await this.prisma.customer.findUnique({
        where: { erpId: code },
        select: { id: true },
      });
      if (!customer) {
        skipped++;
        await this.raw.markProjectFailed(
          'SALES_ORDER',
          record.id,
          `No app customer for erpId ${code} — not onboarded yet`,
        );
        continue;
      }

      // ⚠️ An unmapped ApproveStatus is skipped, not guessed. Showing a customer
      // a wrong order status is worse than showing none, and the row stays queued
      // so it projects itself once ERP_STATUS_MAP is filled in.
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
        await this.raw.markProjectFailed('SALES_ORDER', record.id, 'ERP order has no AMT_UNINCLUDE_TAX_OC');
        continue;
      }

      // Header only. PurchaseItem is deliberately untouched — the ERP exposes no
      // order line items (see CONTRACT.md §3b), and wiping the items of an
      // existing purchase would destroy the per-product Stock Balance Breakdown.
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
  ) {
    super(raw);
  }

  protected async execute(): Promise<JobStats> {
    const pending = await this.raw.pendingProjection('COLLECTION');

    let projected = 0;
    let skipped = 0;
    const done: bigint[] = [];

    for (const record of pending) {
      const payload = record.payload;

      const code = payload.CUSTOMER_CODE as string | undefined;
      if (!code) {
        skipped++;
        await this.raw.markProjectFailed(
          'COLLECTION',
          record.id,
          'Collection has no CUSTOMER_CODE',
        );
        continue;
      }

      const customer = await this.prisma.customer.findUnique({
        where: { erpId: code },
        select: { id: true },
      });
      if (!customer) {
        skipped++;
        await this.raw.markProjectFailed(
          'COLLECTION',
          record.id,
          `No app customer for erpId ${code} — not projected yet`,
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
    return { projected, skipped };
  }
}
