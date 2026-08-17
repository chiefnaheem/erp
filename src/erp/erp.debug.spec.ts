import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ErpClient } from './erp.client';
import { ErpDebugProbe } from './erp.debug';
import { ErpProtocolError } from './erp.errors';

describe('ErpDebugProbe', () => {
  let query: jest.Mock;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const build = async (config: Record<string, unknown>) => {
    query = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ErpDebugProbe,
        { provide: ErpClient, useValue: { query } },
        { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
      ],
    }).compile();
    return moduleRef.get(ErpDebugProbe);
  };

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const logged = (s: jest.SpyInstance) => s.mock.calls.map((c) => String(c[0])).join('\n');

  it('does nothing unless ERP_DEBUG_STARTUP is on', async () => {
    const probe = await build({ ERP_DEBUG_STARTUP: false });
    await probe.onApplicationBootstrap();
    expect(query).not.toHaveBeenCalled();
  });

  // All NINE documented query endpoints are probed — including customer (which
  // used to be skipped) and customer_credit_line (which was never implemented) —
  // so one restart shows a sample row for every erp_raw table.
  it('calls all 9 query endpoints and logs a per-endpoint result', async () => {
    const probe = await build({ ERP_DEBUG_STARTUP: true, ERP_BASE_URL: 'http://erp/api' });
    query.mockResolvedValue({
      execution: { code: '0' },
      rows: [{ DOC_NO: 'X' }],
      total: null,
    });

    await probe.onApplicationBootstrap();

    expect(query).toHaveBeenCalledTimes(9);
    const out = logged(logSpy);
    expect(out).toMatch(/yvijucrm\.customer\.query/);
    expect(out).toMatch(/yvijucrm\.customer_credit_line\.query/);
    expect(out).toMatch(/customer_credit/);
    expect(out).toMatch(/sales_return/);
    expect(out).toMatch(/ar_refund/);
    expect(out).toMatch(/9\/9 endpoints OK/);
  });

  it('requests exactly one row per endpoint, and asks for the total', async () => {
    const probe = await build({ ERP_DEBUG_STARTUP: true, ERP_BASE_URL: 'http://erp/api' });
    query.mockResolvedValue({ execution: { code: '0' }, rows: [], total: null });

    await probe.onApplicationBootstrap();

    for (const [, options] of query.mock.calls) {
      expect(options).toEqual({ pageSize: 1, isGetCount: true });
    }
  });

  // The point of the probe: show the ACTUAL data each table returned.
  it('logs every field name and value of the sample row, per table', async () => {
    const probe = await build({ ERP_DEBUG_STARTUP: true, ERP_BASE_URL: 'http://erp/api' });
    query.mockResolvedValue({
      execution: { code: '0' },
      total: 42,
      rows: [{ DOC_NO: 'NO_0000018870', CUSTOMER_ID: 'guid-1', QTY_TOTAL: 7, REMARK1: '' }],
    });

    await probe.onApplicationBootstrap();

    const out = logged(logSpy);
    expect(out).toMatch(/erp_raw\.raw_sales_order — 1 sample row, 4 field\(s\), 42 row\(s\) available/);
    expect(out).toMatch(/DOC_NO\s+= 'NO_0000018870'/); // value, not just the name
    expect(out).toMatch(/CUSTOMER_ID\s+= 'guid-1'/);
    expect(out).toMatch(/QTY_TOTAL\s+= 7\s+<number>/); // type shown for non-strings
    expect(out).toMatch(/REMARK1\s+= '' \(empty\)/); // empty is distinguishable from absent
    expect(out).toMatch(/the row is FLAT/);
  });

  // sales_order rows are keyed on the detail-line id; a missing key means the
  // row would be dropped at ingest, so the probe must call that out.
  it('warns when the raw key field is absent from the sample row', async () => {
    const probe = await build({ ERP_DEBUG_STARTUP: true, ERP_BASE_URL: 'http://erp/api' });
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    query.mockResolvedValue({
      execution: { code: '0' },
      total: null,
      rows: [{ DOC_NO: 'NO_1' }], // no SALES_ORDER_DOC_D_ID
    });

    await probe.onApplicationBootstrap();

    expect(logged(warnSpy)).toMatch(/raw key field "SALES_ORDER_DOC_D_ID" is MISSING/);
  });

  it('keeps going when one endpoint fails, and logs the failure detail', async () => {
    const probe = await build({ ERP_DEBUG_STARTUP: true, ERP_BASE_URL: 'http://erp/api' });
    query.mockImplementation((method: string) => {
      // Matches customer_credit AND customer_credit_line — two of the nine.
      if (method.includes('customer_credit')) {
        return Promise.reject(
          new ErpProtocolError(method, '<html>Unauthorized</html>', 200),
        );
      }
      return Promise.resolve({ execution: { code: '0' }, rows: [{ DOC_NO: 'X' }], total: null });
    });

    await probe.onApplicationBootstrap();

    expect(query).toHaveBeenCalledTimes(9); // did not stop at the failure
    expect(logged(errorSpy)).toMatch(/customer_credit: FAILED/);
    expect(logged(errorSpy)).toMatch(/Unauthorized/);
    expect(logged(logSpy)).toMatch(/7\/9 endpoints OK/);
  });
});
