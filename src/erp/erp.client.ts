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
 * The ERP issues a DIFFERENT digi-key per object. A method name is
 * `yvijucrm.<object>.<action>`, and the key is per <object> (shared by that
 * object's .query and .read). This maps each object to its env var; anything not
 * listed or not set falls back to the general ERP_API_KEY.
 */
const OBJECT_KEY_ENV: Record<string, string> = {
  customer: 'ERP_API_KEY_CUSTOMER',
  customer_credit: 'ERP_API_KEY_CUSTOMER_CREDIT',
  sales_order_doc: 'ERP_API_KEY_SALES_ORDER',
  sales_delivery: 'ERP_API_KEY_SALES_DELIVERY',
  sales_return: 'ERP_API_KEY_SALES_RETURN',
  collection_doc: 'ERP_API_KEY_COLLECTION',
  ar_refund_doc: 'ERP_API_KEY_AR_REFUND',
  other_receivable_doc: 'ERP_API_KEY_OTHER_RECEIVABLE',
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

    const parameter = await this.post<ErpQueryParameter<TRow>>(method, {
      pageSize,
      pageNo,
      isGetSchema: options.isGetSchema ?? false,
      isGetCount: options.isGetCount ?? false,
      conditions: options.conditions ?? [],
      orders: options.orders ?? [],
    });

    const rows = parameter.body.rows ?? [];

    // Success log so a running sync shows exactly what each query fetched: the
    // method, which page, how many rows, and a compact preview of the first row
    // so we can confirm real data (and its shape) is coming back.
    this.logger.log(
      `${method} p${pageNo} (size ${pageSize}): fetched ${rows.length} row(s)` +
        (rows.length ? ` — sample: ${this.preview(rows[0])}` : ''),
    );

    return {
      rows,
      pageNo,
      pageSize,
      total: this.extractTotal(parameter.body),
      execution: parameter.execution,
    };
  }

  /**
   * Walk every page of a `.query` method.
   *
   * Terminates on a short page rather than on a total, because the ERP's
   * count field is undocumented and `isGetCount` may not be honoured. Yields
   * page-by-page so callers never hold the whole table in memory.
   */
  async *queryAll<TRow>(
    method: ErpMethod,
    options: Omit<ErpQueryOptions, 'pageNo'> = {},
  ): AsyncGenerator<TRow[], void, void> {
    const pageSize =
      options.pageSize ?? this.config.getOrThrow<number>('ERP_PAGE_SIZE');

    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const page = await this.query<TRow>(method, {
        ...options,
        pageNo,
        pageSize,
      });

      if (page.rows.length === 0) return;

      yield page.rows;

      // A page shorter than requested means we've reached the end.
      if (page.rows.length < pageSize) return;
    }

    this.logger.error(
      `${method}: hit MAX_PAGES (${MAX_PAGES}) without a short page — ` +
        `aborting to avoid an infinite sweep. Pagination may be misbehaving.`,
    );
  }

  /** Fetch specific records via a `.read` method's dataKeys. */
  async read<TRow>(
    method: ErpMethod,
    dataKeys: Record<string, string>[],
  ): Promise<TRow[]> {
    const parameter = await this.post<ErpReadParameter<TRow>>(method, {
      dataKeys,
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
   * The digi-key for a method's object. The ERP issues one key per object, so
   * `yvijucrm.customer.query` and `yvijucrm.customer.read` share the customer
   * key, while a sales order uses a different one. Falls back to the general
   * ERP_API_KEY for any object without its own key configured.
   */
  private apiKeyFor(method: ErpMethod): string {
    const object = method.split('.')[1] ?? '';
    const envName = OBJECT_KEY_ENV[object];
    const specific = envName ? this.config.get<string>(envName)?.trim() : undefined;
    return specific || this.config.getOrThrow<string>('ERP_API_KEY');
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
