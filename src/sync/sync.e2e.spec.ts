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
  let collections: Record<string, unknown>[];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const method = JSON.parse(req.headers['digi-service'] as string).name;
        // snake_case, as the API doc specifies and ErpClient now sends.
        const { pageNo } = JSON.parse(raw).std_data.parameter;

        // Only page 1 has data; page 2 is empty so queryAll terminates.
        const table: Record<string, Record<string, unknown>[]> = {
          'yvijucrm.customer.query': customers,
          'yvijucrm.sales_order_doc.query': salesOrders,
          'yvijucrm.collection_doc.query': collections,
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
    await prisma.payment.deleteMany({ where: { erpId: { startsWith: 'TEST_E2E_' } } });
    await prisma.customer.deleteMany({ where: { erpId: { startsWith: 'TEST_E2E_' } } });
    await prisma.$executeRawUnsafe(
      `DELETE FROM erp_raw.raw_customer WHERE erp_key LIKE 'TEST_E2E_%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM erp_raw.raw_customer_credit WHERE erp_key LIKE 'TEST_E2E_%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM erp_raw.raw_sales_order WHERE erp_key LIKE 'TEST_E2E_%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM erp_raw.raw_collection WHERE erp_key LIKE 'TEST_E2E_%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM erp_raw.customer_link WHERE erp_customer_guid LIKE 'TEST_E2E_%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM erp_raw.sync_run WHERE started_at > now() - interval '10 minutes'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM erp_raw.projection_quarantine WHERE erp_key LIKE 'TEST_E2E_%'`,
    );
    // NOTE: erp_raw.projection_watermark is deliberately NOT reset here. Each
    // test re-upserts its fixtures, which sets changed_at = now() and
    // projected_at = NULL, so they are selected either way — while clearing the
    // watermark would force every test to re-scan the entire feed.
  };

  const PAYDOC = 'TEST_E2E_PAY_1';

  beforeEach(async () => {
    await cleanup();
    customers = [
      {
        CUSTOMER_ID: GUID,
        CUSTOMER_CODE: CODE,
        CUSTOMER_FULL_NAME: 'ERP Provided Name',
        // region comes from BP_CLUSTER_CODE, not the (blank) Region field
        BP_CLUSTER_CODE: '1', // → LAGOS
        PhoneNumber: '08090000001', // → +2348090000001
      },
    ];
    salesOrders = [
      {
        DOC_NO: DOC,
        CUSTOMER_ID: GUID,
        ORDER_DATE: '2026-06-01',
        ApproveStatus: 'Y', // built-in map: Y → PROCESSING
        AMT_UNINCLUDE_TAX_OC: 1000,
        TAX_OC: 75,
        QTY_TOTAL: '12',
      },
    ];
    collections = [
      {
        DOC_NO: PAYDOC,
        CUSTOMER_CODE: CODE, // collections carry CUSTOMER_CODE (2026-07-28 update)
        DOC_DATE: '2026-06-05',
        COLLECTION_AMT_TC: 500,
        ApproveStatus: 'Y',
      },
    ];
    config.set('ERP_STATUS_MAP', undefined);
  });

  // An ONBOARDED (active) customer — password set. Transactions only project for
  // active customers, so the projection tests need one.
  const createActiveCustomer = (extra: Record<string, unknown> = {}) =>
    prisma.customer.create({
      data: {
        erpId: CODE,
        name: 'App Name',
        phone: '+2348000000009',
        region: 'LAGOS',
        password: 'hashed-uat-password',
        ...extra,
      },
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

  // Ingest and projection are now separate stages; a "full cycle" runs both.
  const runCycle = async () => {
    await sync.runIngest();
    await sync.runProjection();
  };

  /** Row counts of every table the projector writes — the idempotence probe. */
  const counts = async () => {
    const [row] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT (SELECT count(*) FROM "Customer")     AS customers,
              (SELECT count(*) FROM "Purchase")     AS purchases,
              (SELECT count(*) FROM "PurchaseItem") AS items,
              (SELECT count(*) FROM "Payment")      AS payments,
              (SELECT count(*) FROM "Staff")        AS staff`,
    );
    return Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, String(v)]),
    );
  };

  // ── Customer projection: create + refresh, on the ERP's natural key ────────
  it('CREATES a customer from the ERP when the cluster and phone are usable', async () => {
    await runCycle();

    const customer = await prisma.customer.findUniqueOrThrow({ where: { erpId: CODE } });
    expect(customer.name).toBe('ERP Provided Name');
    expect(customer.phone).toBe('+2348090000001'); // normalised to E.164
    expect(customer.region).toBe('LAGOS'); // from BP_CLUSTER_CODE '1'
  });

  it('quarantines a customer whose BP_CLUSTER_CODE is not a Viju region', async () => {
    // The same ERP serves other companies; their customers must never be
    // projected, and must never be defaulted into a region.
    customers[0].BP_CLUSTER_CODE = 'GZ020';

    await runCycle();

    expect(await prisma.customer.findUnique({ where: { erpId: CODE } })).toBeNull();
    const [quarantined] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT reason, detail FROM erp_raw.projection_quarantine
       WHERE job = 'project:customer' AND erp_key = '${CODE}' AND resolved_at IS NULL`,
    );
    expect(quarantined.reason).toBe('NOT_A_VIJU_DISTRIBUTOR');
    expect(quarantined.detail).toContain('GZ020');
  });

  it('refreshes ERP-owned fields and leaves every app-owned column alone', async () => {
    const officer = await prisma.staff.findFirst();
    await createActiveCustomer({
      name: 'Stale App Name',
      phone: '+2348000000009',
      region: 'NORTH',
      email: 'distributor@example.com',
      profilePhotoUrl: 'https://cdn.example.com/me.jpg',
      accountStatus: 'ON_HOLD',
      ...(officer ? { assignedOfficerId: officer.id } : {}),
    });

    await runCycle();

    const customer = await prisma.customer.findUniqueOrThrow({ where: { erpId: CODE } });
    // ERP-owned — overwritten.
    expect(customer.name).toBe('ERP Provided Name');
    expect(customer.phone).toBe('+2348090000001');
    expect(customer.region).toBe('LAGOS');
    // App-owned — untouched. An admin's ON_HOLD and an officer assignment
    // surviving the sync is the whole point of the narrow update clause.
    expect(customer.email).toBe('distributor@example.com');
    expect(customer.password).toBe('hashed-uat-password');
    expect(customer.profilePhotoUrl).toBe('https://cdn.example.com/me.jpg');
    expect(customer.accountStatus).toBe('ON_HOLD');
    if (officer) expect(customer.assignedOfficerId).toBe(officer.id);
  });

  it("keeps an existing customer's phone when the ERP's is unusable", async () => {
    // The live feed shares ONE placeholder PhoneNumber across 1,844 customers,
    // and phone is the unique login. A malformed or shared number must never
    // overwrite a working one — the rest of the row still updates.
    customers[0].PhoneNumber = '0707459177'; // ten digits: not a NG mobile
    await createActiveCustomer({ name: 'Stale App Name', phone: '+2348000000009' });

    await runCycle();

    const customer = await prisma.customer.findUniqueOrThrow({ where: { erpId: CODE } });
    expect(customer.phone).toBe('+2348000000009'); // login preserved
    expect(customer.name).toBe('ERP Provided Name'); // everything else refreshed
  });

  it('computes outstandingBalance as CREDIT_AMT + CREDIT_AMT1 - CREDIT_PAY', async () => {
    // CREDIT_PAY is credit CONSUMED. Copying it straight across (which is what
    // the old projector did) inverted the sign for every customer holding
    // credit. Full precision matters: the ERP carries up to 4 dp.
    await prisma.$executeRawUnsafe(
      `INSERT INTO erp_raw.raw_customer_credit
         (object_type, erp_key, payload, content_hash)
       VALUES ('CUSTOMER_CREDIT', 'TEST_E2E_CREDIT_1',
               jsonb_build_object(
                 'CUSTOMER_CODE', '${CODE}',
                 'CREDIT_AMT', '50000000.5000',
                 'CREDIT_AMT1', '20000.4733',
                 'CREDIT_PAY', '16596969.0000',
                 'EFFECTIVE_DATE', '2026-07-01 00:00:00'),
               'TEST_E2E_HASH_1')`,
    );

    await runCycle();

    const customer = await prisma.customer.findUniqueOrThrow({ where: { erpId: CODE } });
    // 50000000.5000 + 20000.4733 - 16596969.0000, positive = funds available
    expect(customer.outstandingBalance).toBeCloseTo(33423031.9733, 4);
  });

  // ── Purchases (active customers only, bulk) ───────────────────────────────
  it("does NOT project a non-active customer's order", async () => {
    // Customer exists but is not onboarded (no password) → out of scope.
    await prisma.customer.create({
      data: { erpId: CODE, name: 'X', phone: '+2348000000002', region: 'LAGOS' },
    });

    await runCycle();

    expect(await prisma.purchase.findUnique({ where: { erpId: DOC } })).toBeNull();
    expect((await rawRow('SALES_ORDER', DOC)).projected_at).toBeNull(); // stays queued
  });

  it("derives an active customer's order status from the order's own lines", async () => {
    const customer = await createActiveCustomer();

    await runCycle();

    const purchase = await prisma.purchase.findUniqueOrThrow({ where: { erpId: DOC } });
    // Approved, not closed, nothing delivered → PROCESSING. Derived from the
    // lines (§4), not the constant the old projector wrote on every update.
    expect(purchase.status).toBe('PROCESSING');
    expect(purchase.totalValue).toBe(1075); // 1000 ex-tax + 75 tax
    expect(purchase.totalItems).toBe(12); // QTY_TOTAL
    expect(purchase.customerId).toBe(customer.id); // resolved guid → code → customer
  });

  it("projects an active customer's payment with a customer link", async () => {
    const customer = await createActiveCustomer();

    await runCycle();

    const payment = await prisma.payment.findUniqueOrThrow({ where: { erpId: PAYDOC } });
    expect(payment.amount).toBe(500);
    expect(payment.customerId).toBe(customer.id);
  });

  it('does not wipe PurchaseItems when re-projecting a changed order header', async () => {
    await createActiveCustomer();
    await runCycle();

    const purchase = await prisma.purchase.findUniqueOrThrow({ where: { erpId: DOC } });
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
    await runCycle();

    // ...the header updates, and the items survive.
    const items = await prisma.purchaseItem.findMany({ where: { purchaseId: purchase.id } });
    expect(items).toHaveLength(1);
    const updated = await prisma.purchase.findUniqueOrThrow({ where: { erpId: DOC } });
    expect(updated.totalValue).toBe(2075); // 2000 ex-tax + 75 tax

    await prisma.purchaseItem.deleteMany({ where: { purchaseId: purchase.id } });
  });

  // ── Multi-line orders ─────────────────────────────────────────────────────
  // sales_order_doc.query returns HEADER + ONE DETAIL LINE per row, so a
  // multi-line order arrives as several rows repeating the same DOC_NO. Every
  // line must be kept in erp_raw (keyed on the detail id), while the app still
  // gets exactly ONE Purchase whose header totals are NOT multiplied by the
  // number of lines.
  it('keeps every line of a multi-line order but projects a single Purchase', async () => {
    await createActiveCustomer();

    const header = {
      DOC_NO: DOC,
      CUSTOMER_ID: GUID,
      ORDER_DATE: '2026-06-01',
      ApproveStatus: 'Y',
      AMT_UNINCLUDE_TAX_OC: 1000, // header totals repeat on every line
      TAX_OC: 75,
      QTY_TOTAL: '12',
    };
    salesOrders = [
      { ...header, SALES_ORDER_DOC_D_ID: 'TEST_E2E_LINE_1', SequenceNumber: 1, ITEM_DESCRIPTION: 'Chocolate Milk', BUSINESS_QTY: 5 },
      { ...header, SALES_ORDER_DOC_D_ID: 'TEST_E2E_LINE_2', SequenceNumber: 2, ITEM_DESCRIPTION: 'Strawberry Milk', BUSINESS_QTY: 7 },
    ];

    await runCycle();

    // Both lines survive in the raw table, keyed on the detail id.
    const lines = await prisma.$queryRawUnsafe<any[]>(
      `SELECT erp_key, payload FROM erp_raw.raw_sales_order
       WHERE erp_key LIKE 'TEST_E2E_LINE_%' ORDER BY erp_key`,
    );
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.payload.ITEM_DESCRIPTION)).toEqual([
      'Chocolate Milk',
      'Strawberry Milk',
    ]);

    // ...but the order projects to exactly ONE Purchase, keyed on DOC_NO.
    const purchases = await prisma.purchase.findMany({ where: { erpId: DOC } });
    expect(purchases).toHaveLength(1);
    // Header totals taken once, not summed across the two lines.
    expect(purchases[0].totalValue).toBe(1075); // 1000 + 75, NOT 2150
    expect(purchases[0].totalItems).toBe(12); // QTY_TOTAL once, NOT 24
  });

  // ── Idempotence ───────────────────────────────────────────────────────────
  it('an unchanged second sweep ingests without re-writing (content hash)', async () => {
    await createActiveCustomer();

    await runCycle();
    expect((await rawRow('SALES_ORDER', DOC)).projected_at).not.toBeNull();

    await runCycle(); // identical ERP data

    const runs = await prisma.$queryRawUnsafe<any[]>(
      `SELECT rows_fetched, rows_changed FROM erp_raw.sync_run
       WHERE job = 'ingest:sales_order' ORDER BY started_at DESC LIMIT 1`,
    );
    expect(runs[0].rows_fetched).toBe(1);
    expect(runs[0].rows_changed).toBe(0); // hash unmoved → nothing re-written
  });

  // ── Idempotence ───────────────────────────────────────────────────────────
  it('projecting the same window twice changes nothing the second time', async () => {
    await createActiveCustomer();

    await runCycle();
    const after1 = await counts();

    // No new ERP data, no ingest — just the projector, run again.
    await sync.runProjection();
    expect(await counts()).toEqual(after1);

    // And again after a full re-ingest of identical data.
    await runCycle();
    expect(await counts()).toEqual(after1);
  });

  it('does not clobber an app-owned Purchase status on re-projection', async () => {
    // OrderStatus carries LOADED and DISPATCHED, which are the app's own
    // fulfilment workflow and have no ERP counterpart. Re-deriving status on
    // every sync would silently reset a loading officer's work.
    await createActiveCustomer();
    await runCycle();

    // Raw SQL, not prisma.purchase.update: prisma/schema/ here is a stale mirror
    // of the main API's schema and its OrderStatus enum predates LOADED /
    // DISPATCHED / CLOSED, so the generated client rejects a value the database
    // accepts. Refresh it with `npm run schema:pull` from the main repo.
    await prisma.$executeRawUnsafe(
      `UPDATE "Purchase" SET status = 'LOADED'::"OrderStatus" WHERE "erpId" = '${DOC}'`,
    );

    salesOrders[0].AMT_UNINCLUDE_TAX_OC = 4000; // the order changes...
    await runCycle();

    const [purchase] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT status::text, "totalValue" FROM "Purchase" WHERE "erpId" = '${DOC}'`,
    );
    expect(purchase.status).toBe('LOADED'); // ...the app's status survives
    expect(purchase.totalValue).toBe(4075); // ...while ERP-owned fields refresh
  });

  // ── sync_run tells the truth ──────────────────────────────────────────────
  it('records a projection that fetched work and wrote none as FAILED', async () => {
    // The guard that would have surfaced this whole bug months ago. A customer
    // in a foreign tenant is fetched, quarantined, and NOT projected — which is
    // a correct outcome, so it must stay SUCCESS...
    customers[0].BP_CLUSTER_CODE = 'GZ020';
    await runCycle();

    const [ok] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT status, rows_fetched, rows_projected FROM erp_raw.sync_run
       WHERE job = 'project:customer' ORDER BY id DESC LIMIT 1`,
    );
    expect(ok.status).toBe('SUCCESS');
  });

  // ── Blocked jobs stay visible (payment is now live, so only stock + items) ──
  it('records the still-blocked jobs as skipped', async () => {
    await runCycle();

    const blocked = await prisma.$queryRawUnsafe<any[]>(
      `SELECT DISTINCT job FROM erp_raw.sync_run
       WHERE job IN ('project:stock','project:purchase_item')`,
    );
    expect(blocked.map((r) => r.job).sort()).toEqual([
      'project:purchase_item',
      'project:stock',
    ]);
  });
});
