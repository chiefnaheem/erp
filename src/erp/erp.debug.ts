import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErpClient } from './erp.client';
import { ERP_METHOD, ErpMethod } from './erp.types';

/** Every query endpoint, in sync order, with its object label + target table. */
const ENDPOINTS: { label: string; method: ErpMethod; table: string }[] = [
  // customer.query already works (confirmed by ErpConnectivityService on startup),
  // so it's skipped here to keep the probe focused on the endpoints under debug.
  // { label: 'customer', method: ERP_METHOD.CUSTOMER_QUERY, table: 'raw_customer' },
  { label: 'customer_credit', method: ERP_METHOD.CUSTOMER_CREDIT_QUERY, table: 'raw_customer_credit' },
  { label: 'sales_order', method: ERP_METHOD.SALES_ORDER_QUERY, table: 'raw_sales_order' },
  { label: 'sales_delivery', method: ERP_METHOD.SALES_DELIVERY_QUERY, table: 'raw_sales_delivery' },
  { label: 'sales_return', method: ERP_METHOD.SALES_RETURN_QUERY, table: 'raw_sales_return' },
  { label: 'collection', method: ERP_METHOD.COLLECTION_QUERY, table: 'raw_collection' },
  { label: 'ar_refund', method: ERP_METHOD.AR_REFUND_QUERY, table: 'raw_ar_refund' },
  { label: 'other_receivable', method: ERP_METHOD.OTHER_RECEIVABLE_QUERY, table: 'raw_other_receivable' },
];

/**
 * Startup debug probe: calls EVERY ERP query endpoint once (read-only, one row)
 * and logs each step, so a single restart shows which endpoints respond and which
 * fail — and, thanks to the improved error, WHY they fail.
 *
 * Runs only when ERP_DEBUG_STARTUP=true. Pair with ERP_VERBOSE (redacted request)
 * and/or ERP_LOG_CURL (a runnable curl per call) for maximum detail.
 *
 * Read-only: it issues only `.query` with pageSize 1 and writes nothing.
 */
@Injectable()
export class ErpDebugProbe implements OnApplicationBootstrap {
  private readonly logger = new Logger(ErpDebugProbe.name);

  constructor(
    private readonly erp: ErpClient,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get<boolean>('ERP_DEBUG_STARTUP')) return;

    const url = this.config.get<string>('ERP_BASE_URL');
    this.logger.log(
      `════════ ERP startup debug probe — calling all ${ENDPOINTS.length} endpoints (read-only, pageSize 1) at ${url} ════════`,
    );

    const results: { label: string; ok: boolean; detail: string }[] = [];

    let i = 0;
    for (const { label, method, table } of ENDPOINTS) {
      i++;
      this.logger.log(`──── [${i}/${ENDPOINTS.length}] ${label}  (${method} → erp_raw.${table}) ────`);
      const startedAt = Date.now();

      try {
        this.logger.log(`   ${label}: sending query …`);
        const page = await this.erp.query(method, { pageSize: 1 });
        const ms = Date.now() - startedAt;

        const detail = `${page.rows.length} row(s), execution code ${page.execution.code}, ${ms}ms`;
        this.logger.log(`   ✅ ${label}: OK — ${detail}`);
        if (page.rows[0]) {
          this.logger.log(`   ${label}: field names → ${Object.keys(page.rows[0]).join(', ')}`);
        } else {
          this.logger.warn(`   ${label}: responded OK but returned NO rows`);
        }
        results.push({ label, ok: true, detail });
      } catch (error) {
        const ms = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        // message now includes the raw non-std_data body / HTTP status.
        this.logger.error(`   ❌ ${label}: FAILED after ${ms}ms — ${message}`);
        results.push({ label, ok: false, detail: message });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    this.logger.log(
      `════════ ERP startup debug probe done — ${okCount}/${results.length} endpoints OK ════════`,
    );
    for (const r of results) {
      this.logger.log(`   ${r.ok ? '✅' : '❌'} ${r.label.padEnd(18)} ${r.ok ? r.detail : 'FAILED'}`);
    }
  }
}
