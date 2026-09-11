import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProjectionRepository, ProjectionResult } from '../../raw/projection.repository';
import { RawRepository } from '../../raw/raw.repository';
import { buildClusterRegionMap, buildStatusMap } from '../erp.mappers';
import { JobStats, SyncJob } from '../sync.job';

/**
 * Projection = erp_raw → public.*
 *
 * The SQL lives in ProjectionRepository; these classes are the scheduling and
 * bookkeeping shell around it. Each one is an idempotent upsert on the ERP's
 * natural key, driven by a changed_at watermark, inside one transaction under a
 * Postgres advisory lock — so running the same window twice changes nothing the
 * second time, and a killed run costs a repeat rather than a repair.
 *
 * A row that cannot be mapped is NOT dropped. Either it stays queued
 * (projected_at IS NULL) so it heals itself when the blocker clears, or — when
 * it can never project as it stands — it is recorded in
 * erp_raw.projection_quarantine with the reason, which is the answer to "why is
 * this distributor missing from the portal?"
 */

/**
 * A phone must look like a Nigerian mobile in E.164 before it is written:
 * +234, then 7/8/9, then 0/1, then eight digits.
 *
 * Customer.phone is the login AND the OTP target, so a number nobody can be
 * reached on is not an improvement over the one already there — and the feed
 * does contain malformed entries (LATLEK's "0707459177" is ten digits where a
 * Nigerian mobile has eleven). Override with ERP_PHONE_PATTERN if the ERP ever
 * carries numbers from another country.
 *
 * Written as [+] rather than \+ deliberately: a backslash here has to survive a
 * TypeScript string literal, a .env value and Postgres's regex parser, and what
 * a lost backslash leaves behind ("^+...") is not merely wrong but rejected
 * outright — "quantifier operand invalid". A character class needs no escaping
 * in any of those layers.
 */
const DEFAULT_PHONE_PATTERN = '^[+]234[789][01][0-9]{8}$';

/** Shared plumbing: config → projector options → JobStats. */
@Injectable()
abstract class ProjectionJob extends SyncJob {
  // Every projection job is subject to the "fetched rows but wrote nothing"
  // guard. See SyncJob.
  protected readonly alertOnZeroProjection = true;

  constructor(
    raw: RawRepository,
    protected readonly projection: ProjectionRepository,
    protected readonly config: ConfigService,
  ) {
    super(raw);
  }

  /**
   * Force a full re-projection, ignoring the watermark.
   *
   * Normally unnecessary: a job with no watermark row full-scans by itself, so
   * the FIRST run after this change backfills the whole feed with nobody having
   * to ask. Use this (or delete the job's row from
   * erp_raw.projection_watermark) to make it happen again later.
   */
  protected get full(): boolean {
    return this.config.get<boolean>('ERP_PROJECT_FULL') === true;
  }

  /**
   * Generous, because the first backfill run touches the whole customer set.
   *
   * ⚠️ PrismaService pins socket_timeout=120 on the connection string, so the
   * client gives up on any single statement at ~120s no matter what this says.
   * Raising this past that only helps if socket_timeout is raised with it.
   */
  protected get statementTimeoutMs(): number {
    return this.config.get<number>('ERP_PROJECT_STATEMENT_TIMEOUT_MS') ?? 300_000;
  }

  protected get txTimeoutMs(): number {
    return this.config.get<number>('ERP_PROJECT_TX_TIMEOUT_MS') ?? 600_000;
  }

  /** ProjectionResult → JobStats, with the "another instance has it" case logged. */
  protected toStats(result: ProjectionResult): JobStats {
    if (result.lockBusy) {
      this.logger.warn(
        `${this.name}: another instance holds the advisory lock — standing down`,
      );
      return { fetched: 0, projected: 0, skipped: 0, notes: ['advisory lock busy'] };
    }
    return {
      fetched: result.fetched,
      projected: result.projected,
      skipped: result.skipped,
      notes: result.notes,
    };
  }

  /** Open quarantine entries, appended to the run log so they stay visible. */
  protected async quarantineNotes(): Promise<string[]> {
    const summary = await this.projection.quarantineSummary(this.name);
    if (summary.length === 0) return [];
    return [
      'quarantined (not projected): ' +
        summary.map((s) => `${s.reason}=${s.count}`).join(', '),
    ];
  }
}

/**
 * erp_raw.raw_customer (+ raw_customer_credit) → public."Customer".
 *
 * Upserted on "erpId" ← CUSTOMER_CODE. The update clause touches name, phone,
 * region, outstandingBalance and updatedAt — and nothing else, so a customer's
 * email, password, profile photo, ON_HOLD status and assigned officer survive
 * every sync.
 *
 * Customer CREATION is on, which it was not before. It was previously disabled
 * because the ERP's PhoneNumber is a shared placeholder and phone is the unique
 * login; that is still true for most of the feed, so rather than blocking every
 * customer, the colliding rows are quarantined individually and the rest are
 * created. Fixing the ERP's phone data converts the quarantine into customers
 * with no code change.
 */
@Injectable()
export class CustomerProjectionJob extends ProjectionJob {
  readonly name = 'project:customer';

  protected async execute(): Promise<JobStats> {
    const result = await this.projection.projectCustomers({
      full: this.full,
      clusterRegionMap: buildClusterRegionMap(
        this.config.get<string>('ERP_CLUSTER_REGION_MAP'),
      ),
      // ERP-owned by default, per the field-ownership table. Set to false if the
      // ERP's phone data is ever worse than the app's own — it stops phone being
      // overwritten on customers that already exist, while still supplying one
      // for customers being created.
      updatePhone: this.config.get<boolean>('ERP_CUSTOMER_PHONE_UPDATE') !== false,
      // OFF by default. 1,844 of the 1,851 distributors in the feed share one
      // placeholder PhoneNumber, and Customer.phone is UNIQUE, so they cannot
      // all be created as things stand — they are quarantined instead. Turning
      // this on creates them with a non-dialable 'erp:<CODE>' placeholder so
      // they appear in the portal's admin/officer views; it is a deliberate
      // trade, not a default, because phone is the customer login.
      syntheticPhone: this.config.get<boolean>('ERP_CUSTOMER_SYNTHETIC_PHONE') === true,
      phonePattern:
        this.config.get<string>('ERP_PHONE_PATTERN') ?? DEFAULT_PHONE_PATTERN,
      statementTimeoutMs: this.statementTimeoutMs,
      txTimeoutMs: this.txTimeoutMs,
    });

    const stats = this.toStats(result);
    stats.notes = [...(stats.notes ?? []), ...(await this.quarantineNotes())];
    return stats;
  }
}

/**
 * erp_raw.raw_sales_order → public."Purchase", upserted on "erpId" ← DOC_NO.
 *
 * One Purchase per DOC_NO, aggregated across the order's lines. `status` is
 * derived per §4 when the order is first seen and then left alone — the app's
 * LOADED / DISPATCHED states have no ERP counterpart and re-deriving them on
 * every sync would reset a loading officer's work. The backend's reconciler owns
 * that column from then on (VijuNotifier re-triggers it after every run).
 *
 * Scope is unchanged: only ONBOARDED customers' orders are projected
 * (transactions on demand). An order whose customer has not onboarded stays
 * queued and projects itself the moment they do.
 */
@Injectable()
export class PurchaseProjectionJob extends ProjectionJob {
  readonly name = 'project:purchase';

  protected async execute(): Promise<JobStats> {
    // ERP_STATUS_MAP is no longer used to CHOOSE the status — §4's aggregate
    // rules do that — but its keys still decide which ApproveStatus values are
    // projectable at all. That keeps the existing behaviour for the ERP's 'V'
    // rows (2,332 of them), which are not in the map and have never been
    // projected: mapping them to PENDING would show a customer an order the ERP
    // does not consider live.
    const eligible = Object.keys(
      buildStatusMap(this.config.get<string>('ERP_STATUS_MAP')),
    );

    const result = await this.projection.projectPurchases({
      full: this.full,
      eligibleApproveStatuses: eligible,
      statementTimeoutMs: this.statementTimeoutMs,
      txTimeoutMs: this.txTimeoutMs,
    });
    return this.toStats(result);
  }
}

/**
 * Collections → public."Payment", upserted on "erpId" ← DOC_NO.
 *
 * Payment."erpId" is nullable and unique, and ON CONFLICT never fires for NULL,
 * so a payment with no DOC_NO would duplicate on every run. It is required here
 * instead: no key, no insert.
 *
 * runningBalance has no ERP source and is a required column, so it is written as
 * 0 on insert and never touched again (see erp-reconciliation.md).
 */
@Injectable()
export class PaymentProjectionJob extends ProjectionJob {
  readonly name = 'project:payment';

  protected async execute(): Promise<JobStats> {
    const result = await this.projection.projectPayments({
      full: this.full,
      statementTimeoutMs: this.statementTimeoutMs,
      txTimeoutMs: this.txTimeoutMs,
    });
    return this.toStats(result);
  }
}
