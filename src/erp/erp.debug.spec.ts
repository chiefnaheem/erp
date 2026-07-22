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

  it('calls all 7 endpoints (customer is skipped) and logs a per-endpoint result', async () => {
    const probe = await build({ ERP_DEBUG_STARTUP: true, ERP_BASE_URL: 'http://erp/api' });
    query.mockResolvedValue({ execution: { code: '0' }, rows: [{ DOC_NO: 'X' }] });

    await probe.onApplicationBootstrap();

    expect(query).toHaveBeenCalledTimes(7); // customer.query commented out
    const out = logged(logSpy);
    expect(out).not.toMatch(/\bcustomer\b(?!_credit)/); // customer itself not probed
    expect(out).toMatch(/customer_credit/);
    expect(out).toMatch(/sales_return/);
    expect(out).toMatch(/ar_refund/);
    expect(out).toMatch(/7\/7 endpoints OK/);
  });

  it('keeps going when one endpoint fails, and logs the failure detail', async () => {
    const probe = await build({ ERP_DEBUG_STARTUP: true, ERP_BASE_URL: 'http://erp/api' });
    query.mockImplementation((method: string) => {
      if (method.includes('customer_credit')) {
        return Promise.reject(
          new ErpProtocolError(method, '<html>Unauthorized</html>', 200),
        );
      }
      return Promise.resolve({ execution: { code: '0' }, rows: [{ DOC_NO: 'X' }] });
    });

    await probe.onApplicationBootstrap();

    expect(query).toHaveBeenCalledTimes(7); // did not stop at the failure
    expect(logged(errorSpy)).toMatch(/customer_credit: FAILED/);
    expect(logged(errorSpy)).toMatch(/Unauthorized/);
    expect(logged(logSpy)).toMatch(/6\/7 endpoints OK/);
  });
});
