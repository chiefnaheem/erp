import { Logger } from '@nestjs/common';
import { SalesDeliveryIngestJob } from './jobs/ingest.jobs';

/**
 * Deletion reconciliation across a sweep that spans several turns.
 *
 * A full sweep of a big object does not fit in one turn — sales_delivery takes
 * 1,324 pages over ~15 of them — and the key set it reconciles against has to
 * survive those pauses. It did not: every pause cleared the keys and every
 * resumed turn minted a fresh sweep id, so the sweep that finished on
 * 2026-11-18 ended holding 1,056 keys against 1,324,311 rows and the safety
 * check refused it. Deletions had therefore NEVER been applied to
 * sales_delivery, sales_order, collection or other_receivable, and lines
 * deleted in the ERP stayed on the document in the admin portal for good.
 *
 * These tests pin the pause/resume contract, because nothing else does: a
 * single-turn sweep (customer, customer_credit) reconciles correctly either
 * way, which is exactly why the bug went unseen.
 */
describe('full-sweep deletion reconciliation', () => {
  let raw: any;
  let erp: any;
  let config: any;
  let settings: Record<string, unknown>;
  let pages: { pageNo: number; rows: Record<string, unknown>[] }[];
  let pageDelayMs: number;

  const row = (id: string) => ({
    SALES_DELIVERY_D_ID: id,
    DOC_NO: '2510-202611160001',
    LastModifiedDate: '2026-11-18 14:25:39',
  });

  const run = async () => {
    const job = new SalesDeliveryIngestJob(raw, erp, config);
    await (job as any).execute();
  };

  beforeEach(() => {
    pageDelayMs = 0;
    pages = [
      { pageNo: 1, rows: [row('a'), row('b')] },
      { pageNo: 2, rows: [row('c')] },
    ];
    settings = {
      ERP_INCREMENTAL: true,
      ERP_INCREMENTAL_FIELD: 'LastModifiedDate',
      ERP_PAGE_SIZE: 1000,
      ERP_RECONCILE_DELETES: true,
      ERP_RECONCILE_MAX_DELETE_PCT: 20,
      ERP_SWEEP_MAX_MINUTES: 10,
      // Isolate the backfill lane — the catch-up lane shares erp.queryAll.
      ERP_CATCHUP_MAX_MINUTES: 0,
    };
    config = {
      get: (k: string) => settings[k],
      getOrThrow: (k: string) => settings[k],
    };
    raw = {
      tableFor: () => 'raw_sales_delivery',
      getIngestPage: jest.fn().mockResolvedValue(1),
      setIngestPage: jest.fn(),
      clearIngestPage: jest.fn(),
      getWatermark: jest.fn().mockResolvedValue(null), // no watermark ⇒ full sweep
      setWatermark: jest.fn(),
      watermarkUpdatedAt: jest.fn().mockResolvedValue(new Date()),
      markFullSweep: jest.fn(),
      getSweepIdentity: jest.fn().mockResolvedValue(null),
      setSweepIdentity: jest.fn(),
      clearSweepIdentity: jest.fn(),
      recordSeen: jest.fn(),
      seenCount: jest.fn().mockResolvedValue(100),
      rowCount: jest.fn().mockResolvedValue(100),
      countUnseen: jest.fn().mockResolvedValue(3),
      deleteUnseen: jest.fn().mockResolvedValue(3),
      clearSeen: jest.fn(),
      clearStaleSeen: jest.fn(),
      upsertMany: jest.fn().mockImplementation(async (_t: unknown, rows: unknown[]) => {
        if (pageDelayMs) await new Promise((r) => setTimeout(r, pageDelayMs));
        return { fetched: rows.length, changed: 0 };
      }),
      linkCustomers: jest.fn(),
    };
    erp = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      queryAll: jest
        .fn()
        .mockImplementation(async function* (_m: string, opts: any, startPage = 1) {
          // A filtered call is the catch-up/incremental lane, not the sweep.
          if (opts?.conditions?.length) return;
          for (const p of pages) if (p.pageNo >= startPage) yield p;
        }),
    };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('records a sweep identity when a full sweep starts at page 1', async () => {
    await run();
    expect(raw.setSweepIdentity).toHaveBeenCalledTimes(1);
    const [job, sweepId, startedAt] = raw.setSweepIdentity.mock.calls[0];
    expect(job).toBe('ingest:sales_delivery');
    expect(typeof sweepId).toBe('string');
    expect(startedAt).toBeInstanceOf(Date);
    // A fresh sweep still clears what a killed one left behind.
    expect(raw.clearStaleSeen).toHaveBeenCalledWith('SALES_DELIVERY', sweepId);
  });

  it('reuses the stored identity when the sweep resumes, instead of minting a new one', async () => {
    const began = new Date('2026-11-17T06:00:00.000Z');
    raw.getIngestPage.mockResolvedValue(2);
    raw.getSweepIdentity.mockResolvedValue({ sweepId: 'ingest:sales_delivery:777', startedAt: began });

    await run();

    // The old code minted a new id every turn and cleared the previous turn's
    // keys — which is precisely what emptied the key set.
    expect(raw.setSweepIdentity).not.toHaveBeenCalled();
    expect(raw.clearStaleSeen).not.toHaveBeenCalled();
    expect(raw.recordSeen).toHaveBeenCalledWith(
      'SALES_DELIVERY',
      'ingest:sales_delivery:777',
      expect.any(Array),
    );
  });

  it('keeps the recorded keys when a turn runs out of time', async () => {
    settings.ERP_SWEEP_MAX_MINUTES = 0.0005; // 30ms
    pageDelayMs = 40;

    await run();

    expect(raw.recordSeen).toHaveBeenCalled();
    // The pause used to clear them, making a multi-turn sweep unable to reconcile.
    expect(raw.clearSeen).not.toHaveBeenCalled();
    expect(raw.clearSweepIdentity).not.toHaveBeenCalled();
    expect(raw.deleteUnseen).not.toHaveBeenCalled();
  });

  it('judges only rows that already existed when the sweep began', async () => {
    const began = new Date('2026-11-17T06:00:00.000Z');
    raw.getIngestPage.mockResolvedValue(2);
    raw.getSweepIdentity.mockResolvedValue({ sweepId: 'sweep-1', startedAt: began });

    await run();

    // Without this the incremental lane's inserts, made while the sweep crawled,
    // would be deleted for not appearing in a key set recorded before they existed.
    expect(raw.rowCount).toHaveBeenCalledWith('SALES_DELIVERY', began);
    expect(raw.countUnseen).toHaveBeenCalledWith('SALES_DELIVERY', 'sweep-1', began);
    expect(raw.deleteUnseen).toHaveBeenCalledWith('SALES_DELIVERY', 'sweep-1', began);
  });

  it('deletes the rows the completed sweep never returned', async () => {
    raw.countUnseen.mockResolvedValue(3);
    await run();
    expect(raw.deleteUnseen).toHaveBeenCalled();
  });

  it('refuses a reconciliation that would delete more than the cap', async () => {
    raw.rowCount.mockResolvedValue(100);
    raw.countUnseen.mockResolvedValue(21); // 21% — over the 20% cap

    await run();

    expect(raw.deleteUnseen).not.toHaveBeenCalled();
    const warned = (Logger.prototype.warn as jest.Mock).mock.calls
      .map((c) => String(c[0]))
      .join('\n');
    expect(warned).toContain('21 of 100');
  });

  it('applies a raised cap when one is configured', async () => {
    settings.ERP_RECONCILE_MAX_DELETE_PCT = 50;
    raw.rowCount.mockResolvedValue(100);
    raw.countUnseen.mockResolvedValue(21);

    await run();

    expect(raw.deleteUnseen).toHaveBeenCalled();
  });

  it('still refuses to reconcile against a suspiciously thin key set', async () => {
    raw.seenCount.mockResolvedValue(1056);
    raw.rowCount.mockResolvedValue(1_324_311); // the 2026-11-18 sales_delivery sweep

    await run();

    expect(raw.deleteUnseen).not.toHaveBeenCalled();
  });

  it('does not touch anything when the sweep found nothing to delete', async () => {
    raw.countUnseen.mockResolvedValue(0);
    await run();
    expect(raw.deleteUnseen).not.toHaveBeenCalled();
  });

  it('clears the identity and the keys once the sweep completes', async () => {
    await run();
    expect(raw.clearSeen).toHaveBeenCalled();
    expect(raw.clearSweepIdentity).toHaveBeenCalledWith('ingest:sales_delivery');
  });

  it('never reconciles an incremental sweep', async () => {
    raw.getWatermark.mockResolvedValue('2026-11-18 00:00:00');

    await run();

    expect(raw.setSweepIdentity).not.toHaveBeenCalled();
    expect(raw.recordSeen).not.toHaveBeenCalled();
    expect(raw.deleteUnseen).not.toHaveBeenCalled();
  });
});
