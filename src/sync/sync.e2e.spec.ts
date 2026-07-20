import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RawMigrator } from '../raw/raw.migrator';
import { SyncModule } from './sync.module';
import { SyncService } from './sync.service';

/**
 * Full cycle: mock ERP → erp_raw → public.*
 *
 * Runs against the REAL database so the projections are exercised for real.
 * All fixtures use a TEST_E2E_ prefix and are removed afterwards.
 */
describe('Sync cycle (e2e)', () => {
  jest.setTimeout(120_000);

  const CODE = 'TEST_E2E_CODE_1';
  const GUID = 'TEST_E2E_GUID_1';
  const DOC = 'TEST_E2E_DOC_1';

  let server: Server;
  let prisma: PrismaService;
  let sync: SyncService;
  let config: ConfigService;

  // What the mock ERP hands back.
  let customers: Record<string, unknown>[];
  let salesOrders: Record<string, unknown>[];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const method = JSON.parse(req.headers['digi-service'] as string).name;
        const { pageNo } = JSON.parse(raw).std_data.parameter;

        // Only page 1 has data; page 2 is empty so queryAll terminates.
        const table: Record<string, Record<string, unknown>[]> = {
          'yvijucrm.customer.query': customers,
          'yvijucrm.sales_order_doc.query': salesOrders,
        };
        const rows = pageNo === 1 ? (table[method] ?? []) : [];

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ std_data: { execution: { code: '0' }, parameter: { rows } } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              DATABASE_URL: process.env.DATABASE_URL,
              ERP_BASE_URL: `http://127.0.0.1:${port}`,
              ERP_API_KEY: 'test',
              ERP_SERVER_IP: '127.0.0.1',
              ERP_PRODUCT: 'YVIJUCRM',
              ERP_HOST_VERSION: '5.7',
              ERP_ACCOUNT: 'CRM',
              ERP_TIMEZONE: '+8',
              ERP_LANG: 'zh_CN',
              ERP_USER_AGENT: 'python-requests/2.34.2',
              ERP_TIMEOUT_MS: 5000,
              ERP_MAX_RETRIES: 0,
              ERP_PAGE_SIZE: 100,
              SYNC_ENABLED: true,
            }),
          ],
        }),
        PrismaModule,
        SyncModule,
      ],
      providers: [RawMigrator],
    }).compile();

    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    sync = moduleRef.get(SyncService);
    config = moduleRef.get(ConfigService);
    await moduleRef.get(RawMigrator).apply();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const cleanup = async () => {
    // Children before parents — PurchaseItem holds an FK into Purchase.
    await prisma.purchaseItem.deleteMany({
      where: { purchase: { erpId: { startsWith: 'TEST_E2E_' } } },
    });
    await prisma.purchase.deleteMany({ where: { erpId: { startsWith: 'TEST_E2E_' } } });
    await prisma.customer.deleteMany({ where: { erpId: { startsWith: 'TEST_E2E_' } } });
    await prisma.$executeRawUnsafe(
      `DELETE FROM erp_raw.raw_customer WHERE erp_key LIKE 'TEST_E2E_%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM erp_raw.raw_sales_order WHERE erp_key LIKE 'TEST_E2E_%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM erp_raw.customer_link WHERE erp_customer_guid LIKE 'TEST_E2E_%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM erp_raw.sync_run WHERE started_at > now() - interval '10 minutes'`,
    );
  };

  beforeEach(async () => {
    await cleanup();
    customers = [
      { CUSTOMER_ID: GUID, CUSTOMER_CODE: CODE, CUSTOMER_FULL_NAME: 'ERP Provided Name' },
    ];
    salesOrders = [
      {
        DOC_NO: DOC,
        CUSTOMER_ID: GUID,
        ORDER_DATE: '2026-06-01',
        ApproveStatus: 'APPROVED_BY_ERP', // deliberately NOT in the default map
        AMT_UNINCLUDE_TAX_OC: 1000,
        TAX_OC: 75,
        PIECES: 12,
      },
    ];
    config.set('ERP_STATUS_MAP', undefined);
  });

  // type → per-object table (only the two the e2e inspects).
  const RAW_TABLE: Record<string, string> = {
    CUSTOMER: 'raw_customer',
    SALES_ORDER: 'raw_sales_order',
  };
  const rawRow = async (type: string, key: string) =>
    (
      await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM erp_raw.${RAW_TABLE[type]} WHERE erp_key = '${key}'`,
      )
    )[0];

  // ── The single most important safety property ────────────────────────────
  it('NEVER creates a customer from ERP data (no phone/region available)', async () => {
    await sync.runCycle();

    const created = await prisma.customer.findUnique({ where: { erpId: CODE } });
    expect(created).toBeNull(); // must NOT have been inserted

    // ...but the raw payload IS captured, and says why it couldn't project.
    const raw = await rawRow('CUSTOMER', CODE);
    expect(raw.payload).toMatchObject({ CUSTOMER_FULL_NAME: 'ERP Provided Name' });
    expect(raw.projected_at).toBeNull();
    // With no phone source configured, the job cannot create — and says so.
    expect(raw.project_error).toMatch(/no ERP_CUSTOMER_PHONE_FIELD configured/i);
  });

  it('updates an existing customer once they are onboarded in the app', async () => {
    await sync.runCycle(); // customer not onboarded yet → skipped

    await prisma.customer.create({
      data: {
        erpId: CODE,
        name: 'Stale App Name',
        phone: '+2348000000001', // app-owned: the ERP can never supply this
        region: 'LAGOS', // app-owned
      },
    });

    await sync.runCycle();

    const customer = await prisma.customer.findUnique({ where: { erpId: CODE } });
    expect(customer!.name).toBe('ERP Provided Name');
    // The app-owned fields must survive untouched.
    expect(customer!.phone).toBe('+2348000000001');
    expect(customer!.region).toBe('LAGOS');
  });

  it('creates a customer from ERP once a phone source is configured', async () => {
    // Simulate the probe having found phone on a field called CONTACT_TEL and
    // region on UDF_REGION.
    customers[0].CONTACT_TEL = '+2348011122233';
    customers[0].UDF_REGION = 'West';
    config.set('ERP_CUSTOMER_PHONE_FIELD', 'CONTACT_TEL');
    config.set('ERP_CUSTOMER_REGION_FIELD', 'UDF_REGION');
    config.set('ERP_REGION_MAP', '{"West":"SOUTH_WEST","Lagos":"LAGOS"}');

    await sync.runCycle();

    const created = await prisma.customer.findUnique({ where: { erpId: CODE } });
    expect(created).not.toBeNull();
    expect(created!.phone).toBe('+2348011122233');
    expect(created!.region).toBe('SOUTH_WEST');
    expect(created!.name).toBe('ERP Provided Name');

    config.set('ERP_CUSTOMER_PHONE_FIELD', undefined);
    config.set('ERP_CUSTOMER_REGION_FIELD', undefined);
    config.set('ERP_REGION_MAP', undefined);
  });

  it('attaches erpId to an existing phone instead of failing on the unique constraint', async () => {
    // Customer onboarded in-app first, no erpId yet, same phone the ERP will send.
    await prisma.customer.create({
      data: {
        erpId: 'TEST_E2E_PREEXISTING',
        name: 'Signed Up First',
        phone: '+2348044455566',
        region: 'LAGOS',
      },
    });

    customers[0].CONTACT_TEL = '+2348044455566'; // same phone
    customers[0].UDF_REGION = 'Lagos';
    config.set('ERP_CUSTOMER_PHONE_FIELD', 'CONTACT_TEL');
    config.set('ERP_CUSTOMER_REGION_FIELD', 'UDF_REGION');
    config.set('ERP_REGION_MAP', '{"Lagos":"LAGOS","West":"SOUTH_WEST"}');

    await sync.runCycle();

    // No duplicate created; the existing row is now linked to the ERP code.
    const byPhone = await prisma.customer.findUnique({ where: { phone: '+2348044455566' } });
    expect(byPhone!.erpId).toBe(CODE);
    expect(byPhone!.name).toBe('ERP Provided Name');

    await prisma.customer.deleteMany({ where: { phone: '+2348044455566' } });
    config.set('ERP_CUSTOMER_PHONE_FIELD', undefined);
    config.set('ERP_CUSTOMER_REGION_FIELD', undefined);
    config.set('ERP_REGION_MAP', undefined);
  });

  // ── Purchases ────────────────────────────────────────────────────────────
  it('skips an order with an unmapped ApproveStatus rather than guessing one', async () => {
    await prisma.customer.create({
      data: { erpId: CODE, name: 'X', phone: '+2348000000002', region: 'LAGOS' },
    });

    await sync.runCycle();

    expect(await prisma.purchase.findUnique({ where: { erpId: DOC } })).toBeNull();

    const raw = await rawRow('SALES_ORDER', DOC);
    expect(raw.project_error).toMatch(/Unmapped ApproveStatus "APPROVED_BY_ERP"/);
    expect(raw.projected_at).toBeNull(); // stays queued — it will heal itself
  });

  it('projects the order once ApproveStatus is mapped — the queued row heals itself', async () => {
    await prisma.customer.create({
      data: { erpId: CODE, name: 'X', phone: '+2348000000003', region: 'LAGOS' },
    });

    await sync.runCycle(); // skipped: unmapped status

    config.set('ERP_STATUS_MAP', '{"APPROVED_BY_ERP":"PROCESSING"}');
    await sync.runCycle();

    const purchase = await prisma.purchase.findUnique({ where: { erpId: DOC } });
    expect(purchase).not.toBeNull();
    expect(purchase!.status).toBe('PROCESSING');
    expect(purchase!.totalValue).toBe(1075); // 1000 ex-tax + 75 tax
    expect(purchase!.totalItems).toBe(12); // PIECES
    // Resolved Guid → CUSTOMER_CODE → app customer.
    const customer = await prisma.customer.findUnique({ where: { erpId: CODE } });
    expect(purchase!.customerId).toBe(customer!.id);
  });

  it('does not wipe PurchaseItems — the ERP has no line items to replace them with', async () => {
    const customer = await prisma.customer.create({
      data: { erpId: CODE, name: 'X', phone: '+2348000000004', region: 'LAGOS' },
    });
    config.set('ERP_STATUS_MAP', '{"APPROVED_BY_ERP":"PROCESSING"}');
    await sync.runCycle();

    const purchase = await prisma.purchase.findUniqueOrThrow({ where: { erpId: DOC } });
    // Items arrive from the main API's webhook, not the ERP pull.
    await prisma.purchaseItem.create({
      data: {
        purchaseId: purchase.id,
        productName: 'Chocolate Milk',
        quantity: 180,
        unitPrice: 10,
        lineTotal: 1800,
      },
    });

    // A later sweep sees a changed order and re-projects the header...
    salesOrders[0].AMT_UNINCLUDE_TAX_OC = 2000;
    await sync.runCycle();

    // ...and the items — which power the Stock Balance Breakdown — must survive.
    const items = await prisma.purchaseItem.findMany({ where: { purchaseId: purchase.id } });
    expect(items).toHaveLength(1);
    expect(items[0].productName).toBe('Chocolate Milk');

    const updated = await prisma.purchase.findUniqueOrThrow({ where: { erpId: DOC } });
    expect(updated.totalValue).toBe(2075); // 2000 ex-tax + 75 tax, still applied

    await prisma.purchaseItem.deleteMany({ where: { purchaseId: purchase.id } });
    void customer;
  });

  // ── Idempotence: the whole point of content hashing ───────────────────────
  it('an unchanged second sweep projects nothing', async () => {
    await prisma.customer.create({
      data: { erpId: CODE, name: 'ERP Provided Name', phone: '+2348000000005', region: 'LAGOS' },
    });
    config.set('ERP_STATUS_MAP', '{"APPROVED_BY_ERP":"PROCESSING"}');

    await sync.runCycle();
    const afterFirst = await rawRow('SALES_ORDER', DOC);
    expect(afterFirst.projected_at).not.toBeNull();

    await sync.runCycle(); // identical ERP data

    const runs = await prisma.$queryRawUnsafe<any[]>(
      `SELECT rows_fetched, rows_changed FROM erp_raw.sync_run
       WHERE job = 'ingest:sales_order' ORDER BY started_at DESC LIMIT 1`,
    );
    expect(runs[0].rows_fetched).toBe(1);
    expect(runs[0].rows_changed).toBe(0); // hash unmoved → nothing re-written
  });

  // ── Blocked jobs stay visible ────────────────────────────────────────────
  it('records the blocked jobs as skipped instead of silently omitting them', async () => {
    await sync.runCycle();

    const blocked = await prisma.$queryRawUnsafe<any[]>(
      `SELECT DISTINCT job FROM erp_raw.sync_run
       WHERE job IN ('project:stock','project:purchase_item','project:payment')`,
    );
    expect(blocked.map((r) => r.job).sort()).toEqual([
      'project:payment',
      'project:purchase_item',
      'project:stock',
    ]);
  });
});
