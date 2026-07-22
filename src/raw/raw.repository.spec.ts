import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RawMigrator } from './raw.migrator';
import { RawRepository } from './raw.repository';

/**
 * Runs against the real database (DATABASE_URL). Touches only erp_raw.* —
 * nothing in `public` is read or written.
 */
describe('RawRepository (integration)', () => {
  let prisma: PrismaService;
  let repo: RawRepository;

  // The database is remote — connect + migrate comfortably exceeds Jest's 5s default.
  jest.setTimeout(60_000);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PrismaService, RawMigrator, RawRepository],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    await prisma.$connect();
    await moduleRef.get(RawMigrator).apply();
    repo = moduleRef.get(RawRepository);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM erp_raw.raw_sales_order WHERE erp_key LIKE 'TEST_%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM erp_raw.customer_link WHERE erp_customer_guid LIKE 'TEST_%'`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM erp_raw.sync_run WHERE job LIKE 'test_%'`);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM erp_raw.raw_sales_order WHERE erp_key LIKE 'TEST_%'`,
    );
  });

  const key = (r: Record<string, unknown>) => r.DOC_NO as string;

  it('hashes independently of key order — the ERP guarantees no field order', () => {
    const a = RawRepository.hash({ x: 1, y: { b: 2, a: 3 } });
    const b = RawRepository.hash({ y: { a: 3, b: 2 }, x: 1 });
    expect(a).toBe(b);
  });

  it('hashes differently when a value actually changes', () => {
    expect(RawRepository.hash({ x: 1 })).not.toBe(RawRepository.hash({ x: 2 }));
  });

  it('counts a first sweep as all-changed', async () => {
    const result = await repo.upsertMany(
      'SALES_ORDER',
      [
        { DOC_NO: 'TEST_1', AMT: 100 },
        { DOC_NO: 'TEST_2', AMT: 200 },
      ],
      key,
    );
    expect(result).toEqual({ fetched: 2, changed: 2 });
  });

  // The whole reason the raw layer exists: the ERP has no delta support, so we
  // re-fetch everything every cycle and must not re-write what hasn't moved.
  it('reports NO changes when an identical sweep is replayed', async () => {
    const rows = [
      { DOC_NO: 'TEST_1', AMT: 100 },
      { DOC_NO: 'TEST_2', AMT: 200 },
    ];
    await repo.upsertMany('SALES_ORDER', rows, key);

    const second = await repo.upsertMany('SALES_ORDER', rows, key);
    expect(second).toEqual({ fetched: 2, changed: 0 });
  });

  it('detects only the row that actually moved', async () => {
    await repo.upsertMany(
      'SALES_ORDER',
      [
        { DOC_NO: 'TEST_1', AMT: 100 },
        { DOC_NO: 'TEST_2', AMT: 200 },
      ],
      key,
    );

    const second = await repo.upsertMany(
      'SALES_ORDER',
      [
        { DOC_NO: 'TEST_1', AMT: 100 }, // unchanged
        { DOC_NO: 'TEST_2', AMT: 999 }, // changed
      ],
      key,
    );

    expect(second).toEqual({ fetched: 2, changed: 1 });
  });

  // The raw table is shared with live sync data, so scope assertions to our own
  // TEST_ row rather than relying on pendingProjection's ordering.
  const rawRow = async (erpKey: string) =>
    (
      await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, payload, projected_at FROM erp_raw.raw_sales_order WHERE erp_key = '${erpKey}'`,
      )
    )[0];

  it('re-queues a changed row for projection, and leaves an unchanged one alone', async () => {
    await repo.upsertMany('SALES_ORDER', [{ DOC_NO: 'TEST_1', AMT: 100 }], key);

    const inserted = await rawRow('TEST_1');
    expect(inserted.projected_at).toBeNull(); // freshly ingested → pending

    await repo.markProjected('SALES_ORDER', [inserted.id]);
    expect((await rawRow('TEST_1')).projected_at).not.toBeNull();

    // An identical sweep must NOT re-queue it...
    await repo.upsertMany('SALES_ORDER', [{ DOC_NO: 'TEST_1', AMT: 100 }], key);
    expect((await rawRow('TEST_1')).projected_at).not.toBeNull();

    // ...but a real change must.
    await repo.upsertMany('SALES_ORDER', [{ DOC_NO: 'TEST_1', AMT: 555 }], key);
    const requeued = await rawRow('TEST_1');
    expect(requeued.projected_at).toBeNull();
    expect(requeued.payload).toMatchObject({ AMT: 555 });
  });

  it('stores the ERP payload verbatim, including undocumented fields', async () => {
    await repo.upsertMany(
      'SALES_ORDER',
      [{ DOC_NO: 'TEST_1', SOME_UNDOCUMENTED_FIELD: 'surprise' }],
      key,
    );
    expect((await rawRow('TEST_1')).payload).toMatchObject({
      SOME_UNDOCUMENTED_FIELD: 'surprise',
    });
  });

  it('skips rows with no ERP key rather than inventing one', async () => {
    const result = await repo.upsertMany(
      'SALES_ORDER',
      [{ DOC_NO: 'TEST_1' }, { AMT: 5 }], // second row has no DOC_NO
      key,
    );
    expect(result).toEqual({ fetched: 1, changed: 1 });
  });

  it('bridges CUSTOMER_ID (Guid) to CUSTOMER_CODE', async () => {
    await repo.linkCustomer('TEST_guid-1', 'CODE_0000017822');
    expect(await repo.resolveCustomerCode('TEST_guid-1')).toBe('CODE_0000017822');
    expect(await repo.resolveCustomerCode('TEST_unknown')).toBeNull();
  });

  it('records a sync run', async () => {
    const id = await repo.startRun('test_job');
    await repo.finishRun(id, { status: 'SUCCESS', fetched: 10, changed: 3, projected: 3 });

    const [run] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM erp_raw.sync_run WHERE id = ${id}`,
    );
    expect(run.status).toBe('SUCCESS');
    expect(run.rows_fetched).toBe(10);
    expect(run.rows_changed).toBe(3);
    expect(run.finished_at).not.toBeNull();
  });
});
