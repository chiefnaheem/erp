import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ErpClient } from './erp.client';
import { ErpConnectivityService } from './erp.connectivity';
import { ErpApiError, ErpTransportError } from './erp.errors';

describe('ErpConnectivityService', () => {
  let query: jest.Mock;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const build = async (config: Record<string, unknown>) => {
    query = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ErpConnectivityService,
        { provide: ErpClient, useValue: { query } },
        { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
      ],
    }).compile();
    return moduleRef.get(ErpConnectivityService);
  };

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const logged = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => String(c[0])).join('\n');

  it('logs a SUCCESS message when the ERP responds', async () => {
    const svc = await build({ ERP_BASE_URL: 'https://erp.real/api', SYNC_ENABLED: true });
    query.mockResolvedValue({ execution: { code: '0' }, rows: [{ CUSTOMER_CODE: 'C1' }] });

    await svc.onApplicationBootstrap();

    expect(query).toHaveBeenCalledTimes(1);
    expect(logged(logSpy)).toMatch(/Successfully connected to ERP at https:\/\/erp\.real\/api/);
  });

  it('logs a clear ERROR when the ERP is unreachable', async () => {
    const svc = await build({ ERP_BASE_URL: 'https://down.erp/api', SYNC_ENABLED: true });
    query.mockRejectedValue(new ErpTransportError('customer.query', new Error('ECONNREFUSED'), 4));

    await svc.onApplicationBootstrap(); // must not throw

    expect(logged(errorSpy)).toMatch(/Could NOT reach the ERP/);
  });

  it('warns (not errors) when reachable but the credentials are rejected', async () => {
    const svc = await build({ ERP_BASE_URL: 'https://erp.real/api', SYNC_ENABLED: true });
    query.mockRejectedValue(new ErpApiError('customer.query', { code: '401', description: 'bad key' }));

    await svc.onApplicationBootstrap();

    expect(logged(warnSpy)).toMatch(/Reached the ERP.*rejected/s);
  });

  it('skips the check entirely when SYNC_ENABLED=false', async () => {
    const svc = await build({ ERP_BASE_URL: 'https://erp.real/api', SYNC_ENABLED: false });

    await svc.onApplicationBootstrap();

    expect(query).not.toHaveBeenCalled();
    expect(logged(logSpy)).toMatch(/skipped \(SYNC_ENABLED=false\)/);
  });
});
