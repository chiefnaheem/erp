import { ProjectionRepository } from './projection.repository';
import { VijuRegion } from '../sync/erp.mappers';

const clusterRegionMap: Record<string, VijuRegion> = {
  '1': 'LAGOS',
  '2': 'EASTERN',
  '3': 'SOUTH_SOUTH',
  '4': 'WESTERN',
  '5': 'NORTH',
};

/**
 * THE LOST UPDATE.
 *
 * A projection run is one transaction, but Postgres READ COMMITTED gives each
 * STATEMENT its own snapshot. The step that marks raw rows consumed used to be
 * written as `UPDATE ... WHERE <selector>`, which therefore re-evaluated the
 * selector at the END of the run and matched rows the ingest had changed since
 * the values were read at the start. Those rows were stamped
 * `projected_at = now()` carrying content nothing had projected — and because
 * the selector (`projected_at IS NULL OR changed_at > watermark`) is the only
 * way a row comes back, they were stranded until the ERP touched them again.
 *
 * Signature, measured on 2026-11-19: projected_at EARLIER than changed_at —
 * 635 rows in raw_customer_credit (stale outstanding balances), 168 in
 * raw_collection (stale payments), 17 in raw_sales_order (stale orders).
 *
 * These assert the fix at the only level that does not need a live database:
 * the SQL the repository emits. Every consume statement must compare changed_at
 * against the snapshot the run actually read.
 */
describe('projection consume statements cannot lose an update', () => {
  /** Every statement the run executed, in order. */
  let sql: string[];
  let repo: ProjectionRepository;

  const opts = {
    full: false,
    statementTimeoutMs: 1000,
    txTimeoutMs: 1000,
    maxRowsPerRun: 1000,
    eligibleApproveStatuses: ['Y'],
    updatePhone: true,
    syntheticPhone: false,
    phonePattern: '^\\+234[0-9]{10}$',
    clusterRegionMap,
  };

  beforeEach(() => {
    sql = [];
    const tx = {
      $executeRawUnsafe: (text: string) => {
        sql.push(text);
        return Promise.resolve(1);
      },
      // One shape that satisfies every reader in the file: the advisory lock
      // (ok), count() (n), scanCursor() (cursor_value) and advanceWatermark (wm).
      $queryRawUnsafe: (text: string) => {
        sql.push(text);
        return Promise.resolve([
          { ok: true, n: 1n, cursor_value: '0', wm: null, max_id: null },
        ]);
      },
    };
    const prisma = {
      withRetry: (work: () => Promise<unknown>) => work(),
      $transaction: (work: (t: unknown) => Promise<unknown>) => work(tx),
      $queryRaw: () => Promise.resolve([]),
      $executeRaw: () => Promise.resolve(0),
      $queryRawUnsafe: () => Promise.resolve([]),
    };
    repo = new ProjectionRepository(prisma as never);
    // A watermark must exist or selector() collapses to TRUE and the statements
    // under test would not be representative.
    jest
      .spyOn(repo as unknown as { getWatermark: () => Promise<Date | null> }, 'getWatermark')
      .mockResolvedValue(new Date('2026-11-19T00:00:00Z'));
  });

  afterEach(() => jest.restoreAllMocks());

  /** The statements that declare a raw row consumed. */
  const consumeStatements = () =>
    sql.filter((s) => /SET\s+projected_at\s*=\s*now\(\)/i.test(s));

  it('guards every "projected_at = now()" with a changed_at comparison', async () => {
    await repo.projectCustomers(opts);
    await repo.projectPurchases(opts);
    await repo.projectPayments(opts);

    const consumes = consumeStatements();
    expect(consumes.length).toBeGreaterThanOrEqual(3);
    for (const statement of consumes) {
      expect(statement).toMatch(/changed_at\s*=\s*\w+\.changed_at/);
    }
  });

  it('consumes credit rows from a snapshot, never by re-running the selector', async () => {
    await repo.projectCustomers(opts);

    const creditConsume = consumeStatements().find((s) =>
      /raw_customer_credit/i.test(s),
    );
    expect(creditConsume).toBeDefined();
    // The snapshot, not the live predicate. `projected_at IS NULL` re-evaluated
    // here is the bug itself.
    expect(creditConsume).toMatch(/erp_proj_credit_seen/);
    expect(creditConsume).not.toMatch(/projected_at IS NULL/);
  });

  it('captures the credit snapshot BEFORE reading the values it projects', async () => {
    // Order matters and only one order is safe. Snapshot first: a row the
    // ingest changes mid-run fails the guard and stays queued. Snapshot last:
    // it matches the guard while the balance came from older content — which is
    // the lost update, reintroduced.
    await repo.projectCustomers(opts);

    const snapshot = sql.findIndex((s) => /CREATE TEMP TABLE erp_proj_credit_seen/i.test(s));
    const candidates = sql.findIndex((s) => /CREATE TEMP TABLE erp_proj_customer/i.test(s));
    expect(snapshot).toBeGreaterThanOrEqual(0);
    expect(candidates).toBeGreaterThanOrEqual(0);
    expect(snapshot).toBeLessThan(candidates);
  });

  it('consumes order lines by row id, not by DOC_NO re-read from the live table', async () => {
    await repo.projectPurchases(opts);

    const orderConsume = consumeStatements().find((s) => /raw_sales_order/i.test(s));
    expect(orderConsume).toBeDefined();
    // Via erp_proj_line, which holds every line of every affected document
    // together with the changed_at each line had when it was read.
    expect(orderConsume).toMatch(/erp_proj_line/);
    expect(orderConsume).toMatch(/r\.id\s*=\s*l\.id/);
  });
});
