import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosResponse } from 'axios';
import { firstValueFrom } from 'rxjs';
import { ErpApiError, ErpProtocolError, ErpTransportError } from './erp.errors';
import {
  ErpEnvelope,
  ErpMethod,
  ErpPage,
  ErpQueryOptions,
  ErpQueryParameter,
  ErpReadParameter,
} from './erp.types';

/** Stop runaway pagination if the ERP never returns a short page. */
const MAX_PAGES = 10_000;

/**
 * The ERP issues a DIFFERENT digi-key per METHOD, not per object.
 *
 * The API doc's sample requests show a distinct `digi-key` for every single
 * method — including `.query` vs `.read` of the SAME object (e.g.
 * sales_order_doc.query uses C57349…, sales_order_doc.read uses 8F49B6…). An
 * earlier version of this file assumed one key per object; that only ever worked
 * because the sync uses `.query` exclusively.
 *
 * A method name is `yvijucrm.<object>.<action>`. This maps each object onto the
 * SHORT alias used in the env var names, and the key is resolved most-specific
 * first (see apiKeyFor):
 *
 *   1. ERP_API_KEY_<ALIAS>_<ACTION>   e.g. ERP_API_KEY_SALES_ORDER_READ
 *   2. ERP_API_KEY_<ALIAS>            e.g. ERP_API_KEY_SALES_ORDER   (back-compat)
 *   3. ERP_API_KEY                    global fallback
 *
 * Step 2 is what keeps every existing .env working unchanged: a deployment that
 * only ever calls .query and set the object-level key keeps resolving to it.
 */
const OBJECT_KEY_ALIAS: Record<string, string> = {
  customer: 'CUSTOMER',
  customer_credit: 'CUSTOMER_CREDIT',
  customer_credit_line: 'CUSTOMER_CREDIT_LINE',
  sales_order_doc: 'SALES_ORDER',
  sales_delivery: 'SALES_DELIVERY',
  sales_return: 'SALES_RETURN',
  collection_doc: 'COLLECTION',
  ar_refund_doc: 'AR_REFUND',
  other_receivable_doc: 'OTHER_RECEIVABLE',
};

@Injectable()
export class ErpClient {
  private readonly logger = new Logger(ErpClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Fetch a single page of a `.query` method. */
  async query<TRow>(
    method: ErpMethod,
    options: ErpQueryOptions = {},
  ): Promise<ErpPage<TRow>> {
    const pageNo = options.pageNo ?? 1;
    const pageSize =
      options.pageSize ?? this.config.getOrThrow<number>('ERP_PAGE_SIZE');

    // Body keys are snake_case, exactly as the API doc's sample requests specify
    // (page_size / page_no / is_get_schema / is_get_count). An earlier version
    // sent camelCase; the gateway happened to accept it, but that was undefined
    // behaviour — and the failure mode if it ever stopped would be silent
    // (page_no ignored → every page identical → sweep "succeeds" with page 1).
    const parameter = await this.post<ErpQueryParameter<TRow>>(method, {
      page_size: pageSize,
      page_no: pageNo,
      is_get_schema: options.isGetSchema ?? false,
      is_get_count: options.isGetCount ?? false,
      conditions: options.conditions ?? [],
      orders: options.orders ?? [],
    });

    const rows = parameter.body.rows ?? [];
    const total = this.extractTotal(parameter.body);

    // Success log so a running sync shows exactly what each query fetched: the
    // method, which page, how many rows, and a compact preview of the first row
    // so we can confirm real data (and its shape) is coming back.
    this.logger.log(
      `${method} p${pageNo} (size ${pageSize}): fetched ${rows.length} row(s)` +
        (total !== null ? `, total ${total}` : '') +
        (parameter.execution.token_id
          ? ` [token ${parameter.execution.token_id}]`
          : '') +
        (rows.length ? ` — sample: ${this.preview(rows[0])}` : ''),
    );

    return {
      rows,
      pageNo,
      pageSize,
      total,
      execution: parameter.execution,
    };
  }

  /**
   * Walk every page of a `.query` method, yielding `{ pageNo, rows }`.
   *
   * Terminates on a short page rather than on a total, because the ERP's count
   * field is undocumented and `isGetCount` may not be honoured. Yields
   * page-by-page so callers never hold the whole table in memory.
   *
   * Resilience (this is what keeps big sweeps from failing every cycle):
   *  - `startPage` lets a caller RESUME an interrupted sweep instead of
   *    restarting from page 1.
   *  - Each page is retried on a transient error (a non-std_data ERP response, or
   *    a transport drop). If it still fails after ERP_PAGE_RETRIES, that single
   *    page is SKIPPED (logged) and the sweep continues — one bad page no longer
   *    discards the whole sweep. The skipped rows are re-fetched next full cycle.
   */
  async *queryAll<TRow>(
    method: ErpMethod,
    options: Omit<ErpQueryOptions, 'pageNo'> = {},
    startPage = 1,
  ): AsyncGenerator<{ pageNo: number; rows: TRow[] }, void, void> {
    const pageSize =
      options.pageSize ?? this.config.getOrThrow<number>('ERP_PAGE_SIZE');
    const pageRetries = this.config.get<number>('ERP_PAGE_RETRIES') ?? 3;

    const firstPage = Math.max(1, startPage);

    for (let pageNo = firstPage; pageNo <= MAX_PAGES; pageNo++) {
      let page: ErpPage<TRow> | null = null;

      // Ask for the row count on the FIRST page of the sweep only. The doc
      // defines is_get_count but never names the field the total comes back in,
      // so extractTotal() probes for it — asking once per sweep is enough to
      // learn it (and to log how much we expect) without paying for it on every
      // page. A caller that sets isGetCount explicitly keeps control.
      const isGetCount =
        options.isGetCount ?? (pageNo === firstPage ? true : false);

      for (let attempt = 1; attempt <= pageRetries; attempt++) {
        try {
          page = await this.query<TRow>(method, {
            ...options,
            pageNo,
            pageSize,
            isGetCount,
          });
          break;
        } catch (error) {
          // Only bad-response / transport hiccups are page-retryable. A business
          // error (bad key, no permission) is fatal — rethrow it.
          const retryable =
            error instanceof ErpProtocolError || error instanceof ErpTransportError;
          if (!retryable) throw error;

          if (attempt === pageRetries) {
            this.logger.error(
              `${method} p${pageNo}: failed after ${pageRetries} attempts — SKIPPING this page, continuing sweep. ${
                error instanceof Error ? error.message.split('\n')[0] : String(error)
              }`,
            );
          } else {
            await this.sleep(500 * 2 ** (attempt - 1));
          }
        }
      }

      // Page was skipped after exhausting retries — move on to the next page.
      if (!page) continue;

      if (page.rows.length === 0) return;

      yield { pageNo, rows: page.rows };

      // A page shorter than requested means we've reached the end.
      if (page.rows.length < pageSize) return;
    }

    this.logger.error(
      `${method}: hit MAX_PAGES (${MAX_PAGES}) without a short page — ` +
        `aborting to avoid an infinite sweep. Pagination may be misbehaving.`,
    );
  }

  /**
   * Fetch specific records via a `.read` method's data_keys.
   *
   * ⚠️ The required key set differs PER OBJECT and is not uniform. Some objects
   * take a single key (sales_order_doc / sales_delivery / sales_return:
   * `DOC_NO`; customer: `CUSTOMER_CODE`), while collection_doc, ar_refund_doc and
   * other_receivable_doc additionally require all six `Owner_Org_*` fields, and
   * customer_credit requires eight. See READ_KEY_FIELDS in erp.types.ts for the
   * documented set, and readKeysFor() to build one.
   */
  async read<TRow>(
    method: ErpMethod,
    dataKeys: Record<string, string>[],
  ): Promise<TRow[]> {
    const parameter = await this.post<ErpReadParameter<TRow>>(method, {
      data_keys: dataKeys,
    });
    return parameter.body.result?.success ?? [];
  }

  /**
   * Escape hatch: POST an arbitrary parameter object and return the RAW body.
   * Used by the probe to inspect undocumented responses — the docs are known to
   * be incomplete, so we must be able to see exactly what comes back.
   */
  async raw(
    method: ErpMethod,
    parameter: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.dispatch(method, parameter);
    return response.data;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private async post<TParam>(
    method: ErpMethod,
    parameter: Record<string, unknown>,
  ): Promise<{ body: TParam; execution: ErpEnvelope<TParam>['std_data']['execution'] }> {
    const response = await this.dispatch(method, parameter);
    const envelope = response.data as ErpEnvelope<TParam>;

    if (!envelope?.std_data?.execution) {
      throw new ErpProtocolError(method, response.data, response.status);
    }

    const { execution, parameter: body } = envelope.std_data;

    // The ERP answers 200 even when the call failed — the body is the only
    // reliable signal of success.
    if (execution.code !== '0') {
      throw new ErpApiError(method, execution);
    }

    return { body, execution };
  }

  /** Send the request, retrying transport failures with exponential backoff. */
  private async dispatch(
    method: ErpMethod,
    parameter: Record<string, unknown>,
  ): Promise<AxiosResponse> {
    const maxRetries = this.config.getOrThrow<number>('ERP_MAX_RETRIES');
    const url = this.config.getOrThrow<string>('ERP_BASE_URL');
    const verbose = this.config.get<boolean>('ERP_VERBOSE');
    const logCurl = this.config.get<boolean>('ERP_LOG_CURL');
    const body = { std_data: { parameter } };

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const headers = this.buildHeaders(method);

      if (verbose) {
        // digi-key is the API secret — redact it so a verbose log can't leak it.
        this.logger.log(
          `→ ${method} POST ${url} (attempt ${attempt})\n` +
            `  headers: ${JSON.stringify(this.redactHeaders(headers))}\n` +
            `  body: ${JSON.stringify(body)}`,
        );
      }

      // A copy-pasteable curl for reproducing this exact request (real key). Only
      // on the first attempt, to avoid repeating it on every retry.
      if (logCurl && attempt === 1) {
        this.logger.warn(
          `curl to reproduce ${method} (contains the real digi-key):\n` +
            this.toCurl(url, headers, body),
        );
      }

      try {
        return await firstValueFrom(
          this.http.post(url, body, {
            headers,
            timeout: this.config.getOrThrow<number>('ERP_TIMEOUT_MS'),
            // Never throw on status — business errors arrive as 200 and real
            // HTTP errors are classified below.
            validateStatus: () => true,          

          }),
        ).then((response) => {
          if (response.status >= 500) {
            throw new Error(`HTTP ${response.status} from ERP`);
          }
          if (response.status >= 400) {
            // 4xx is our fault (bad key, bad path) — retrying won't fix it.
            throw new ErpApiError(method, {
              code: String(response.status),
              description: `HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 300)}`,
            });
          }
          return response;
        });
      } catch (error) {
        // Don't burn retries on errors that cannot succeed on a second try.
        if (error instanceof ErpApiError) throw error;

        lastError = error;
        const isLast = attempt === maxRetries + 1;
        if (isLast) break;

        const backoffMs = 500 * 2 ** (attempt - 1);
        this.logger.warn(
          `${method} attempt ${attempt}/${maxRetries + 1} failed ` +
            `(${this.describe(error)}) — retrying in ${backoffMs}ms`,
        );
        await this.sleep(backoffMs);
      }
    }

    throw new ErpTransportError(method, lastError, maxRetries + 1);
  }

  /**
   * The digi-key for a method. The ERP issues one key PER METHOD, so
   * `yvijucrm.customer.query` and `yvijucrm.customer.read` have different keys.
   *
   * Resolved most-specific first, so an existing object-level .env keeps working:
   *   ERP_API_KEY_CUSTOMER_QUERY → ERP_API_KEY_CUSTOMER → ERP_API_KEY
   */
  private apiKeyFor(method: ErpMethod): string {
    const [, object, action] = method.split('.');
    const alias = OBJECT_KEY_ALIAS[object ?? ''];

    if (alias) {
      const candidates = [
        `ERP_API_KEY_${alias}_${(action ?? '').toUpperCase()}`,
        `ERP_API_KEY_${alias}`,
      ];
      for (const name of candidates) {
        const value = this.config.get<string>(name)?.trim();
        if (value) return value;
      }
    }

    return this.config.getOrThrow<string>('ERP_API_KEY');
  }

  /**
   * Built per request, not once: digi-service carries the method name and
   * digi-host carries a fresh timestamp.
   */
  private buildHeaders(method: ErpMethod): Record<string, string> {
    const ip = this.config.getOrThrow<string>('ERP_SERVER_IP');

    const digiHost = {
      ver: this.config.getOrThrow<string>('ERP_HOST_VERSION'),
      prod: this.config.getOrThrow<string>('ERP_PRODUCT'),
      timezone: this.config.getOrThrow<string>('ERP_TIMEZONE'),
      ip,
      id: '',
      lang: this.config.getOrThrow<string>('ERP_LANG'),
      acct: this.config.getOrThrow<string>('ERP_ACCOUNT'),
      // Format is unspecified in the docs; epoch millis until told otherwise.
      timestamp: String(Date.now()),
    };

    const digiService = {
      prod: 'E10',
      ip,
      name: method,
      id: '03_External',
    };

    const headers: Record<string, string> = {
      'digi-key': this.apiKeyFor(method),
      'digi-host': JSON.stringify(digiHost),
      'digi-service': JSON.stringify(digiService),
      'digi-data-exchange-protocol': '1.0',
      'digi-type': 'sync',
      'Content-Type': 'application/json',
      // These make the ERP gateway respond — it was observed to require a
      // recognised User-Agent and an explicit Accept.
      Accept: '*/*',
      'User-Agent': this.config.getOrThrow<string>('ERP_USER_AGENT'),
      Connection: 'keep-alive',
    };

    // Only override Host when explicitly configured; otherwise the HTTP client
    // sets it correctly from the URL.
    const hostHeader = this.config.get<string>('ERP_HOST_HEADER');
    if (hostHeader) headers.Host = hostHeader;

    return headers;
  }

  /**
   * The total-count field name is not documented. Rather than guess one, look
   * for any plausible numeric key so `isGetCount` still gives us something, and
   * return null when it doesn't
   */
  private extractTotal(body: Record<string, unknown>): number | null {
    for (const key of ['count', 'totalCount', 'total', 'recordCount', 'totalRows']) {
      const value = body[key];
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    }
    return null;
  }

  /**
   * Copy of the headers with the digi-key (the API secret) masked. Verbose
   * logging must never write the raw key to a log file.
   */
  private redactHeaders(headers: Record<string, string>): Record<string, string> {
    const key = headers['digi-key'];
    const masked = key
      ? `***${key.slice(-4)} (len ${key.length})`
      : String(key);
    return { ...headers, 'digi-key': masked };
  }

  /**
   * A shell-safe, copy-pasteable curl for a request. Every value is wrapped in
   * single quotes with embedded quotes escaped, so it can be pasted straight into
   * a terminal. Includes the real digi-key — only reached when ERP_LOG_CURL is on.
   */
  private toCurl(
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): string {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const lines = [`curl -X POST ${q(url)}`];
    for (const [name, value] of Object.entries(headers)) {
      lines.push(`  -H ${q(`${name}: ${value}`)}`);
    }
    lines.push(`  -d ${q(JSON.stringify(body))}`);
    return lines.join(' \\\n');
  }

  /** A compact, log-safe one-line preview of a fetched row. */
  private preview(row: unknown): string {
    const text = JSON.stringify(row);
    if (text === undefined) return String(row);
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  }

  private describe(error: unknown): string {
    const axiosError = error as AxiosError;
    if (axiosError?.code) return axiosError.code;
    return error instanceof Error ? error.message : String(error);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
