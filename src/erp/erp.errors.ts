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
    /** HTTP status of the offending response, when known. */
    readonly status?: number,
  ) {
    super(
      `ERP ${method} returned a non-std_data response` +
        (status !== undefined ? ` (HTTP ${status})` : '') +
        ` — actual body: ${describeBody(body)}`,
    );
    this.name = 'ErpProtocolError';
  }
}

/**
 * A short, log-safe rendering of whatever the ERP actually returned. This is the
 * evidence needed to tell a wrong/missing API key (auth page, HTML, empty) from a
 * genuine protocol change — so it goes straight into the error message.
 */
function describeBody(body: unknown): string {
  if (body === null || body === undefined) return '<empty>';

  const text = typeof body === 'string' ? body : safeStringify(body);
  const trimmed = text.trim();
  if (trimmed === '') return '<empty>';

  const kind = /^\s*</.test(trimmed)
    ? 'looks like HTML/XML — often an auth or gateway error page'
    : typeof body === 'string'
      ? 'plain text'
      : 'json';

  const snippet = trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
  return `[${kind}] ${snippet}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
