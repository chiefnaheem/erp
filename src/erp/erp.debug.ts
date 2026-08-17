import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErpClient } from './erp.client';
import { ERP_METHOD, ErpMethod } from './erp.types';

/**
 * Every `.query` endpoint in the API index, with its object label and the
 * erp_raw table it lands in, plus the field this object's raw rows are keyed on
 * (so the log shows whether that key is actually present and unique-looking).
 */
const ENDPOINTS: {
  label: string;
  method: ErpMethod;
  table: string;
  keyField: string;
}[] = [
  { label: 'customer', method: ERP_METHOD.CUSTOMER_QUERY, table: 'raw_customer', keyField: 'CUSTOMER_CODE' },
  { label: 'customer_credit', method: ERP_METHOD.CUSTOMER_CREDIT_QUERY, table: 'raw_customer_credit', keyField: 'CUSTOMER_CREDIT_ID' },
  { label: 'customer_credit_line', method: ERP_METHOD.CUSTOMER_CREDIT_LINE_QUERY, table: 'raw_customer_credit_line', keyField: 'CUSTOMER_CREDIT_LINE_ID' },
  { label: 'sales_order', method: ERP_METHOD.SALES_ORDER_QUERY, table: 'raw_sales_order', keyField: 'SALES_ORDER_DOC_D_ID' },
  { label: 'sales_delivery', method: ERP_METHOD.SALES_DELIVERY_QUERY, table: 'raw_sales_delivery', keyField: 'DOC_NO' },
  { label: 'sales_return', method: ERP_METHOD.SALES_RETURN_QUERY, table: 'raw_sales_return', keyField: 'DOC_NO' },
  { label: 'collection', method: ERP_METHOD.COLLECTION_QUERY, table: 'raw_collection', keyField: 'DOC_NO' },
  { label: 'ar_refund', method: ERP_METHOD.AR_REFUND_QUERY, table: 'raw_ar_refund', keyField: 'DOC_NO' },
  { label: 'other_receivable', method: ERP_METHOD.OTHER_RECEIVABLE_QUERY, table: 'raw_other_receivable', keyField: 'DOC_NO' },
];

/**
 * Startup debug probe: calls EVERY `.query` endpoint once with page_size 1 and
 * logs the row it got back IN FULL, per table — so a single restart shows, for
 * each of the nine ERP objects: whether it responds, what its fields are called,
 * what the actual values look like, whether our raw key field is present, and
 * whether the payload is flat or nested.
 *
 * Runs only when ERP_DEBUG_STARTUP=true. Pair with ERP_VERBOSE (redacted
 * request) and/or ERP_LOG_CURL (a runnable curl per call) for maximum detail.
 *
 * Read-only: it issues only `.query` with page_size 1 and writes nothing.
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
      `════════ ERP startup debug probe — calling all ${ENDPOINTS.length} query endpoints ` +
        `(read-only, page_size 1) at ${url} ════════`,
    );

    const results: {
      label: string;
      table: string;
      ok: boolean;
      rows: number;
      total: number | null;
      keyPresent: boolean;
      fields: number;
      ms: number;
      detail: string;
    }[] = [];

    let i = 0;
    for (const { label, method, table, keyField } of ENDPOINTS) {
      i++;
      this.logger.log(
        `──── [${i}/${ENDPOINTS.length}] ${label}  (${method} → erp_raw.${table}) ────`,
      );
      const startedAt = Date.now();

      try {
        this.logger.log(`   ${label}: sending query (page_size 1) …`);
        const page = await this.erp.query<Record<string, unknown>>(method, {
          pageSize: 1,
          isGetCount: true,
        });
        const ms = Date.now() - startedAt;
        const row = page.rows[0];

        this.logger.log(
          `   ✅ ${label}: OK — ${page.rows.length} row(s), ` +
            `total ${page.total ?? 'not reported'}, execution code ${page.execution.code}, ${ms}ms`,
        );

        if (!row) {
          this.logger.warn(`   ⚠️ ${label}: responded OK but returned NO rows`);
          results.push({
            label, table, ok: true, rows: 0, total: page.total,
            keyPresent: false, fields: 0, ms,
            detail: 'responded OK but returned no rows',
          });
          continue;
        }

        this.logDataForTable(label, table, keyField, row, page.total);

        results.push({
          label,
          table,
          ok: true,
          rows: page.rows.length,
          total: page.total,
          keyPresent: row[keyField] !== undefined && row[keyField] !== null,
          fields: Object.keys(row).length,
          ms,
          detail: `${Object.keys(row).length} field(s)`,
        });
      } catch (error) {
        const ms = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        // message includes the raw non-std_data body / HTTP status.
        this.logger.error(`   ❌ ${label}: FAILED after ${ms}ms — ${message}`);
        results.push({
          label, table, ok: false, rows: 0, total: null,
          keyPresent: false, fields: 0, ms, detail: message,
        });
      }
    }

    this.logSummary(results);
  }

  /**
   * The per-table data dump: every field name, every field's actual value, the
   * raw-key check, and a flat-vs-nested verdict.
   *
   * Values are printed in full rather than truncated — with page_size 1 that is
   * exactly one row per table, and seeing the real values is the entire point
   * (it is how we confirm, e.g., that a sales-order row carries a detail line,
   * or that PhoneNumber is a shared placeholder rather than a real number).
   */
  private logDataForTable(
    label: string,
    table: string,
    keyField: string,
    row: Record<string, unknown>,
    total: number | null,
  ): void {
    const entries = Object.entries(row);
    const width = entries.reduce((max, [k]) => Math.max(max, k.length), 0);

    this.logger.log(
      `   ┌─ erp_raw.${table} — 1 sample row, ${entries.length} field(s)` +
        (total !== null ? `, ${total} row(s) available` : '') +
        ' ─────────',
    );
    for (const [key, value] of entries) {
      this.logger.log(`   │ ${key.padEnd(width)} = ${this.render(value)}`);
    }
    this.logger.log(`   └${'─'.repeat(60)}`);

    // Is the field we key this object's raw rows on actually there?
    const keyValue = row[keyField];
    if (keyValue === undefined || keyValue === null || keyValue === '') {
      this.logger.warn(
        `   ⚠️ ${label}: raw key field "${keyField}" is MISSING/empty on this row — ` +
          `rows without it are skipped at ingest`,
      );
    } else {
      this.logger.log(`   ${label}: raw key ${keyField} = ${String(keyValue)}`);
    }

    // Flat vs nested decides whether a document's detail lines arrive as a
    // nested array or as repeated flat rows — which in turn decides what the
    // raw table must be keyed on.
    const nested = entries.filter(([, v]) => v !== null && typeof v === 'object');
    for (const [key, value] of nested) {
      const shape = Array.isArray(value)
        ? `array[${value.length}], first element: ${JSON.stringify(value[0])}`
        : `object: ${JSON.stringify(value)}`;
      this.logger.log(`   ${label}: nested "${key}" → ${shape}`);
    }
    if (!nested.length) {
      this.logger.log(
        `   ${label}: no nested arrays/objects — the row is FLAT, so any detail ` +
          `lines arrive as repeated rows sharing the same document number`,
      );
    }
  }

  private logSummary(
    results: {
      label: string;
      table: string;
      ok: boolean;
      rows: number;
      total: number | null;
      keyPresent: boolean;
      fields: number;
      ms: number;
      detail: string;
    }[],
  ): void {
    const okCount = results.filter((r) => r.ok).length;
    this.logger.log(
      `════════ ERP startup debug probe done — ${okCount}/${results.length} endpoints OK ════════`,
    );
    this.logger.log(
      `   ${'OBJECT'.padEnd(21)} ${'TABLE'.padEnd(25)} ${'ROWS'.padEnd(5)} ` +
        `${'FIELDS'.padEnd(7)} ${'TOTAL'.padEnd(9)} KEY`,
    );
    for (const r of results) {
      if (!r.ok) {
        this.logger.log(`   ❌ ${r.label.padEnd(19)} ${r.table.padEnd(25)} FAILED`);
        continue;
      }
      this.logger.log(
        `   ✅ ${r.label.padEnd(19)} ${r.table.padEnd(25)} ` +
          `${String(r.rows).padEnd(5)} ${String(r.fields).padEnd(7)} ` +
          `${String(r.total ?? '—').padEnd(9)} ${r.keyPresent ? 'ok' : 'MISSING'}`,
      );
    }
  }

  /** One-line rendering of a field value, with its type when it isn't a string. */
  private render(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value === '' ? "'' (empty)" : `'${value}'`;
    if (typeof value === 'object') return `${JSON.stringify(value)}  <${Array.isArray(value) ? 'array' : 'object'}>`;
    return `${String(value)}  <${typeof value}>`;
  }
}
