import { ErpExecution } from './erp.types';

/**
 * The ERP returned HTTP 200 but execution.code !== '0' — a business-level
 * failure (bad key, no permission, malformed condition). Retrying will not help.
 */
export class ErpApiError extends Error {
  constructor(
    readonly method: string,
    readonly execution: ErpExecution,
  ) {
    super(
      `ERP ${method} failed: code=${execution.code}` +
        (execution.description ? ` — ${execution.description}` : '') +
        (execution.sql_code ? ` (sql_code=${execution.sql_code})` : ''),
    );
    this.name = 'ErpApiError';
  }
}

/** Transport-level failure (timeout, connection reset, 5xx). Worth retrying. */
export class ErpTransportError extends Error {
  constructor(
    readonly method: string,
    readonly cause: unknown,
    readonly attempts: number,
  ) {
    super(
      `ERP ${method} unreachable after ${attempts} attempt(s): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'ErpTransportError';
  }
}

/** The response did not match the std_data envelope at all. */
export class ErpProtocolError extends Error {
  constructor(
    readonly method: string,
    readonly body: unknown,
  ) {
    super(`ERP ${method} returned a non-std_data response`);
    this.name = 'ErpProtocolError';
  }
}
