import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ErpClient } from './erp.client';
import { ErpApiError, ErpTransportError } from './erp.errors';
import { ERP_METHOD } from './erp.types';

/** A stand-in E10 server so we can assert protocol handling without the real ERP. */
interface MockCall {
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

describe('ErpClient', () => {
  let server: Server;
  let baseUrl: string;
  let calls: MockCall[];
  let respond: (call: MockCall) => { status: number; body: unknown };

  beforeEach(async () => {
    calls = [];
    respond = () => ({
      status: 200,
      body: { std_data: { execution: { code: '0' }, parameter: { rows: [] } } },
    });

    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const call = { headers: req.headers, body: JSON.parse(raw || '{}') };
        calls.push(call);
        const { status, body } = respond(call);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const build = async (extra: Record<string, unknown> = {}) => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        HttpModule,
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          load: [
            () => ({
              ERP_BASE_URL: baseUrl,
              ERP_API_KEY: 'test-key',
              ERP_SERVER_IP: '10.0.0.1',
              ERP_PRODUCT: 'YVIJUCRM',
              ERP_HOST_VERSION: '5.7',
              ERP_ACCOUNT: 'CRM',
              ERP_TIMEZONE: '+8',
              ERP_LANG: 'zh_CN',
              ERP_TIMEOUT_MS: 2000,
              ERP_MAX_RETRIES: 2,
              ERP_PAGE_SIZE: 2,
              ...extra,
            }),
          ],
        }),
      ],
      providers: [ErpClient],
    }).compile();
    return moduleRef.get(ErpClient);
  };

  it('sends the digi-* headers the E10 protocol requires', async () => {
    const client = await build();
    await client.query(ERP_METHOD.CUSTOMER_QUERY);

    const { headers } = calls[0];
    expect(headers['digi-key']).toBe('test-key');
    expect(headers['digi-data-exchange-protocol']).toBe('1.0');
    expect(headers['digi-type']).toBe('sync');

    // digi-service must name the method being invoked — it is how E10 routes.
    const service = JSON.parse(headers['digi-service'] as string);
    expect(service.name).toBe(ERP_METHOD.CUSTOMER_QUERY);
    expect(service.prod).toBe('E10');
    expect(service.id).toBe('03_External');

    const host = JSON.parse(headers['digi-host'] as string);
    expect(host.prod).toBe('YVIJUCRM');
    expect(host.timezone).toBe('+8');
    expect(host.timestamp).toEqual(expect.any(String));
  });

  it('uses the object-specific digi-key, falling back to ERP_API_KEY', async () => {
    const client = await build({
      ERP_API_KEY: 'fallback-key',
      ERP_API_KEY_CUSTOMER: 'customer-key',
      ERP_API_KEY_SALES_ORDER: 'order-key',
      // no ERP_API_KEY_COLLECTION → collection must fall back
    });

    await client.query(ERP_METHOD.CUSTOMER_QUERY);
    await client.query(ERP_METHOD.SALES_ORDER_QUERY);
    await client.query(ERP_METHOD.COLLECTION_QUERY);
    await client.read(ERP_METHOD.CUSTOMER_READ, [{ CUSTOMER_CODE: 'C1' }]);

    expect(calls[0].headers['digi-key']).toBe('customer-key'); // customer.query
    expect(calls[1].headers['digi-key']).toBe('order-key'); // sales_order.query
    expect(calls[2].headers['digi-key']).toBe('fallback-key'); // collection → fallback
    expect(calls[3].headers['digi-key']).toBe('customer-key'); // customer.READ shares the key
  });

  it('wraps the request in a std_data envelope', async () => {
    const client = await build();
    await client.query(ERP_METHOD.CUSTOMER_QUERY, { pageNo: 3, pageSize: 50 });

    expect(calls[0].body).toEqual({
      std_data: {
        parameter: {
          pageSize: 50,
          pageNo: 3,
          isGetSchema: false,
          isGetCount: false,
          conditions: [],
          orders: [],
        },
      },
    });
  });

  // The trap: E10 answers 200 even when the call failed.
  it('throws on a business error despite HTTP 200', async () => {
    respond = () => ({
      status: 200,
      body: {
        std_data: {
          execution: { code: '1', description: 'No permission', sql_code: 'E42' },
          parameter: {},
        },
      },
    });

    const client = await build();
    await expect(client.query(ERP_METHOD.CUSTOMER_QUERY)).rejects.toThrow(ErpApiError);
    expect(calls).toHaveLength(1); // must NOT retry a business error
  });

  it('retries 5xx with backoff, then succeeds', async () => {
    let attempt = 0;
    respond = () => {
      attempt++;
      if (attempt < 3) return { status: 503, body: { error: 'unavailable' } };
      return {
        status: 200,
        body: {
          std_data: {
            execution: { code: '0' },
            parameter: { rows: [{ CUSTOMER_CODE: 'C1' }] },
          },
        },
      };
    };

    const client = await build();
    const page = await client.query(ERP_METHOD.CUSTOMER_QUERY);

    expect(calls).toHaveLength(3);
    expect(page.rows).toEqual([{ CUSTOMER_CODE: 'C1' }]);
  });

  it('gives up with a transport error once retries are exhausted', async () => {
    respond = () => ({ status: 500, body: {} });
    const client = await build();
    await expect(client.query(ERP_METHOD.CUSTOMER_QUERY)).rejects.toThrow(ErpTransportError);
    expect(calls).toHaveLength(3); // 1 initial + 2 retries
  });

  it('does not retry a 4xx — a bad key will never succeed', async () => {
    respond = () => ({ status: 401, body: { message: 'bad digi-key' } });
    const client = await build();
    await expect(client.query(ERP_METHOD.CUSTOMER_QUERY)).rejects.toThrow(ErpApiError);
    expect(calls).toHaveLength(1);
  });

  // Pagination must terminate on a short page, since the count field is undocumented.
  it('walks all pages and stops on a short page', async () => {
    const pages: Record<number, unknown[]> = {
      1: [{ id: 1 }, { id: 2 }],
      2: [{ id: 3 }, { id: 4 }],
      3: [{ id: 5 }], // short → last
    };
    respond = (call) => ({
      status: 200,
      body: {
        std_data: {
          execution: { code: '0' },
          parameter: { rows: pages[call.body.std_data.parameter.pageNo] ?? [] },
        },
      },
    });

    const client = await build();
    const seen: unknown[] = [];
    for await (const batch of client.queryAll(ERP_METHOD.CUSTOMER_QUERY)) {
      seen.push(...batch);
    }

    expect(seen).toHaveLength(5);
    expect(calls).toHaveLength(3); // must not request a 4th page
  });

  it('stops cleanly when the first page is empty', async () => {
    const client = await build();
    const seen: unknown[] = [];
    for await (const batch of client.queryAll(ERP_METHOD.CUSTOMER_QUERY)) {
      seen.push(...batch);
    }
    expect(seen).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('logs a success line with row count and a data sample', async () => {
    respond = () => ({
      status: 200,
      body: {
        std_data: {
          execution: { code: '0' },
          parameter: { rows: [{ CUSTOMER_CODE: 'CODE_1', CUSTOMER_FULL_NAME: 'Acme Ltd' }] },
        },
      },
    });

    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const client = await build();
    await client.query(ERP_METHOD.CUSTOMER_QUERY, { pageNo: 1 });

    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/yvijucrm\.customer\.query p1/);
    expect(logged).toMatch(/fetched 1 row/);
    expect(logged).toMatch(/Acme Ltd/); // the actual data appears in the log
    logSpy.mockRestore();
  });

  it('verbose mode logs the request headers + body, with the API key redacted', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const client = await build({ ERP_VERBOSE: true });
    await client.query(ERP_METHOD.CUSTOMER_QUERY, { pageNo: 1 });

    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // The outgoing request is logged: method, headers, and the std_data body.
    expect(logged).toMatch(/→ yvijucrm\.customer\.query POST/);
    expect(logged).toMatch(/"digi-service"/);
    expect(logged).toMatch(/"std_data"/);
    // The raw API key must NOT appear — only the redacted form.
    expect(logged).not.toMatch(/test-key/);
    expect(logged).toMatch(/\*\*\*-key \(len 8\)/);
    logSpy.mockRestore();
  });

  it('does NOT log the request body when verbose is off', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const client = await build(); // ERP_VERBOSE defaults off
    await client.query(ERP_METHOD.CUSTOMER_QUERY, { pageNo: 1 });

    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toMatch(/→ yvijucrm/); // no request-line log
    logSpy.mockRestore();
  });

  it('unwraps read() results from parameter.result.success', async () => {
    respond = () => ({
      status: 200,
      body: {
        std_data: {
          execution: { code: '0' },
          parameter: { result: { success: [{ DOC_NO: 'NO_1' }] } },
        },
      },
    });

    const client = await build();
    const rows = await client.read(ERP_METHOD.SALES_ORDER_READ, [{ DOC_NO: 'NO_1' }]);

    expect(rows).toEqual([{ DOC_NO: 'NO_1' }]);
    expect(calls[0].body.std_data.parameter.dataKeys).toEqual([{ DOC_NO: 'NO_1' }]);
  });
});
