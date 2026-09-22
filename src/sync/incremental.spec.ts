import { Logger } from '@nestjs/common';
import { ErpApiError } from '../erp/erp.errors';
import { ERP_METHOD } from '../erp/erp.types';
import { CustomerIngestJob } from './jobs/ingest.jobs';

/**
 * The incremental filter and its fallback.
 *
 * Context that makes the fallback load-bearing: as of 2026-08-23 the API docs
 * list LastModifiedDate on all eight objects but the live ERP rejects it
 * (CE66014). Without the fallback, switching the sync to incremental would fail
 * every ingest job on the first page.
 */
describe('incremental ingest', () => {
  let raw: any;
  let erp: any;
  let config: any;
  let settings: Record<string, unknown>;

  const build = () => new CustomerIngestJob(raw, erp, config);

  /** Drive a job's sweep and hand back the options the client was called with. */
  const runAndCapture = async () => {
    const job = build();
    await (job as any).execute();
    return erp.queryAll.mock.calls;
  };

  beforeEach(() => {
    settings = {
      ERP_INCREMENTAL: true,
      ERP_INCREMENTAL_FIELD: 'LastModifiedDate',
      ERP_PAGE_SIZE: 100,
      ERP_INCREMENTAL_OVERLAP_MINUTES: 30,
    };
    config = {
      get: (k: string) => settings[k],
      getOrThrow: (k: string) => settings[k],
    };
    raw = {
      tableFor: () => 'raw_customer',
      getIngestPage: jest.fn().mockResolvedValue(1),
      setIngestPage: jest.fn(),
      clearIngestPage: jest.fn(),
      getWatermark: jest.fn().mockResolvedValue(null),
      watermarkUpdatedAt: jest.fn().mockResolvedValue(new Date()),
      markFullSweep: jest.fn(),
      recordSeen: jest.fn(),
      seenCount: jest.fn().mockResolvedValue(10),
      rowCount: jest.fn().mockResolvedValue(10),
      deleteUnseen: jest.fn().mockResolvedValue(0),
      clearSeen: jest.fn(),
      clearStaleSeen: jest.fn(),
      setWatermark: jest.fn(),
      upsertMany: jest.fn().mockResolvedValue({ fetched: 0, changed: 0 }),
      linkCustomers: jest.fn(),
    };
    erp = { queryAll: jest.fn().mockImplementation(async function* () {}) };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // The unavailable flag is static — reset it between tests.
    (CustomerIngestJob as any).__proto__.incrementalUnavailable = false;
    Object.getPrototypeOf(CustomerIngestJob).incrementalUnavailable = false;
  });

  afterEach(() => jest.restoreAllMocks());

  it('sweeps in FULL when there is no watermark yet (first ever run)', async () => {
    raw.getWatermark.mockResolvedValue(null);
    const calls = await runAndCapture();
    expect(calls[0][0]).toBe(ERP_METHOD.CUSTOMER_QUERY);
    expect(calls[0][1].conditions).toBeUndefined(); // no filter
    expect(calls[0][1].orders).toEqual([
      { field_name: 'LastModifiedDate', order_type: 'asc' },
      // ...and a unique tiebreaker, without which paging is not deterministic.
      { field_name: 'CUSTOMER_CODE', order_type: 'asc' },
    ]);
  });

  it('filters on LastModifiedDate once a watermark exists', async () => {
    raw.getWatermark.mockResolvedValue('2026-08-28 10:00:00');
    const calls = await runAndCapture();
    const [, options] = calls[0];
    expect(options.conditions).toEqual([
      // watermark minus the 30-minute overlap, in the ERP's own format
      { field_name: 'LastModifiedDate', operator: '>=', value: '2026-08-28 09:30:00' },
    ]);
  });

  it('sweeps in FULL when incremental is switched off', async () => {
    settings.ERP_INCREMENTAL = false;
    raw.getWatermark.mockResolvedValue('2026-08-28 10:00:00');
    const calls = await runAndCapture();
    expect(calls[0][1].conditions).toBeUndefined();
  });

  it("stamps the watermark from the ERP's OWN newest timestamp, not our clock", async () => {
    // The bug this prevents: stamping our UTC clock and comparing it against the
    // ERP's local timestamps. Whenever our clock ran ahead, the next filter asked
    // for changes since a moment that had not happened yet on their side, and
    // updates were silently skipped for good.
    erp.queryAll = jest.fn().mockImplementation(async function* () {
      yield {
        pageNo: 1,
        rows: [
          { CUSTOMER_CODE: 'C1', LastModifiedDate: '2026-08-30 08:00:00' },
          { CUSTOMER_CODE: 'C2', LastModifiedDate: '2026-08-31 11:14:28' }, // newest
          { CUSTOMER_CODE: 'C3', LastModifiedDate: '2026-08-29 23:00:00' },
        ],
      };
    });

    await (build() as any).execute();
    expect(raw.setWatermark).toHaveBeenCalledWith('ingest:customer', '2026-08-31 11:14:28');
  });

  it('does NOT advance the watermark when the sweep returned nothing', async () => {
    raw.getWatermark.mockResolvedValue('2026-08-28 10:00:00');
    erp.queryAll = jest.fn().mockImplementation(async function* () {}); // no rows
    await (build() as any).execute();
    // Advancing here would skip the window this sweep was supposed to cover.
    expect(raw.setWatermark).not.toHaveBeenCalled();
  });

  it('forces a FULL sweep when the last one is older than ERP_FULL_SWEEP_DAYS', async () => {
    settings.ERP_FULL_SWEEP_DAYS = 7;
    raw.getWatermark.mockResolvedValue('2026-08-28 10:00:00');
    raw.watermarkUpdatedAt.mockResolvedValue(new Date(Date.now() - 8 * 24 * 3600 * 1000));

    const calls = await runAndCapture();
    // No filter: this is the backstop for changes the ERP makes without moving
    // LastModifiedDate, and for back-dated edits.
    expect(calls[0][1].conditions).toBeUndefined();
  });

  it('falls back to a full sweep when the ERP does not know the column', async () => {
    raw.getWatermark.mockResolvedValue('2026-08-28 10:00:00');
    const rejection = new ErpApiError(ERP_METHOD.CUSTOMER_QUERY, {
      code: '-1',
      description:
        'CE66014:在编号为YQPD_001的限定方案中，找不到别名为LastModifiedDate的查询列。',
    });

    erp.queryAll = jest
      .fn()
      // filtered attempt blows up on the first page…
      .mockImplementationOnce(async function* () {
        throw rejection;
      })
      // …and the unfiltered retry succeeds
      .mockImplementationOnce(async function* () {
        yield { pageNo: 1, rows: [{ CUSTOMER_CODE: 'C1', CUSTOMER_ID: 'g1' }] };
      });

    const job = build();
    const stats = await (job as any).execute();

    expect(erp.queryAll).toHaveBeenCalledTimes(2);
    expect(erp.queryAll.mock.calls[0][1].conditions).toHaveLength(1); // tried filtered
    expect(erp.queryAll.mock.calls[1][1].conditions).toBeUndefined(); // fell back to full
    expect(stats.fetched).toBe(0); // upsertMany is stubbed; the sweep completed
    // No LastModifiedDate on the rows, so there is nothing trustworthy to stamp —
    // but the full sweep IS recorded, which resets the 7-day backstop clock.
    expect(raw.setWatermark).not.toHaveBeenCalled();
    expect(raw.markFullSweep).toHaveBeenCalled();
  });

  it('does NOT swallow a real ERP error', async () => {
    raw.getWatermark.mockResolvedValue('2026-08-28 10:00:00');
    erp.queryAll = jest.fn().mockImplementationOnce(async function* () {
      throw new ErpApiError(ERP_METHOD.CUSTOMER_QUERY, {
        code: '-1',
        description: 'no permission for this service',
      });
    });
    await expect((build() as any).execute()).rejects.toThrow(/no permission/);
  });

  it('normalises a legacy ISO watermark before sending it to the ERP', async () => {
    // Watermarks written by the older clock-based version look like
    // 2026-08-31T13:30:01.148Z. The ERP only understands YYYY-MM-DD HH:mm:ss.
    raw.getWatermark.mockResolvedValue('2026-08-31T13:30:01.148Z');
    const calls = await runAndCapture();
    expect(calls[0][1].conditions[0].value).toBe('2026-08-31 13:00:01');
  });

  it('pauses a long sweep so other objects are not starved', async () => {
    // The real incident: a full sales-order sweep ran 8-14 hours holding the
    // ingest lock, and customer_credit went four days without a refresh.
    settings.ERP_SWEEP_MAX_MINUTES = 10;
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    erp.queryAll = jest.fn().mockImplementation(async function* () {
      for (let page = 1; page <= 100; page++) {
        now += 6 * 60_000; // each page takes 6 minutes
        yield { pageNo: page, rows: [{ CUSTOMER_CODE: 'C' + page }] };
      }
    });

    await (build() as any).execute();

    // Stopped after the budget was spent, not after all 100 pages.
    expect(raw.setIngestPage).toHaveBeenCalled();
    const lastPageSaved = raw.setIngestPage.mock.calls.at(-1)[1];
    expect(lastPageSaved).toBeLessThan(100);
    // Paused, so it must NOT look finished: cursor kept, watermark untouched.
    expect(raw.clearIngestPage).not.toHaveBeenCalled();
    expect(raw.setWatermark).not.toHaveBeenCalled();
  });

  it('finishes normally when the sweep fits inside its budget', async () => {
    settings.ERP_SWEEP_MAX_MINUTES = 10;
    erp.queryAll = jest.fn().mockImplementation(async function* () {
      yield { pageNo: 1, rows: [{ CUSTOMER_CODE: 'C1', LastModifiedDate: '2026-09-09 10:00:00' }] };
    });

    await (build() as any).execute();
    expect(raw.clearIngestPage).toHaveBeenCalled();
    expect(raw.setWatermark).toHaveBeenCalledWith('ingest:customer', '2026-09-09 10:00:00');
  });

  describe('reconciling rows the ERP no longer returns', () => {
    // The incident: the ERP edited customer_credit's EFFECTIVE_DATE in place.
    // Because our key includes that field the edit arrived as a NEW row and the
    // old one stayed forever — five customers kept a ghost row showing
    // EFFECTIVE_DATE 0001-01-01 long after the ERP had moved them on.
    const fullSweep = () => {
      raw.getWatermark.mockResolvedValue(null); // no watermark => full sweep
      erp.queryAll = jest.fn().mockImplementation(async function* () {
        yield { pageNo: 1, rows: [{ CUSTOMER_CODE: 'A' }, { CUSTOMER_CODE: 'B' }] };
      });
    };

    it('records the keys a full sweep returned, then deletes what it did not', async () => {
      fullSweep();
      raw.deleteUnseen.mockResolvedValue(5);
      await (build() as any).execute();

      expect(raw.recordSeen).toHaveBeenCalled();
      expect(raw.deleteUnseen).toHaveBeenCalled();
      expect(raw.clearSeen).toHaveBeenCalled(); // always cleaned up
    });

    it('NEVER reconciles an incremental sweep', async () => {
      raw.getWatermark.mockResolvedValue('2026-09-01 00:00:00');
      erp.queryAll = jest.fn().mockImplementation(async function* () {
        yield { pageNo: 1, rows: [{ CUSTOMER_CODE: 'A' }] };
      });
      await (build() as any).execute();
      // An incremental sweep only sees what changed; deleting the rest would
      // empty the table.
      expect(raw.recordSeen).not.toHaveBeenCalled();
      expect(raw.deleteUnseen).not.toHaveBeenCalled();
    });

    it('does not delete when the sweep paused half way', async () => {
      settings.ERP_SWEEP_MAX_MINUTES = 10;
      raw.getWatermark.mockResolvedValue(null);
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      erp.queryAll = jest.fn().mockImplementation(async function* () {
        for (let page = 1; page <= 50; page++) {
          now += 6 * 60_000;
          yield { pageNo: page, rows: [{ CUSTOMER_CODE: 'C' + page }] };
        }
      });

      await (build() as any).execute();
      // A partial key set must never drive a delete.
      expect(raw.deleteUnseen).not.toHaveBeenCalled();
      expect(raw.clearSeen).toHaveBeenCalled();
    });

    it('refuses to reconcile when the sweep saw far fewer keys than we hold', async () => {
      fullSweep();
      raw.seenCount.mockResolvedValue(3);   // sweep returned almost nothing
      raw.rowCount.mockResolvedValue(1800); // but we hold a full table
      await (build() as any).execute();
      expect(raw.deleteUnseen).not.toHaveBeenCalled(); // would have wiped the object
      expect(raw.clearSeen).toHaveBeenCalled();
    });
  });

  it('always sweeps in FULL for jobs listed in ERP_FULL_SWEEP_JOBS', async () => {
    // customer_credit keys on a mutable amount, so it must reconcile every cycle
    // rather than accumulate ghosts between weekly full sweeps.
    settings.ERP_FULL_SWEEP_JOBS = 'ingest:customer';
    raw.getWatermark.mockResolvedValue('2026-09-01 00:00:00'); // a watermark exists...
    erp.queryAll = jest.fn().mockImplementation(async function* () {
      yield { pageNo: 1, rows: [{ CUSTOMER_CODE: 'C1' }] };
    });
    const calls = await runAndCapture();
    expect(calls[0][1].conditions).toBeUndefined(); // ...and is deliberately ignored
    expect(raw.recordSeen).toHaveBeenCalled();      // so reconciliation runs
  });

  it('still sweeps incrementally for jobs NOT in that list', async () => {
    settings.ERP_FULL_SWEEP_JOBS = 'ingest:sales_return';
    raw.getWatermark.mockResolvedValue('2026-09-01 00:00:00');
    const calls = await runAndCapture();
    expect(calls[0][1].conditions).toHaveLength(1);
  });

  it('clears key sets abandoned by a killed sweep before starting a new one', async () => {
    // A sweep killed mid-flight (pm2 restart, watchdog exit) never runs its
    // cleanup, so its keys would accumulate forever.
    raw.getWatermark.mockResolvedValue(null); // full sweep
    erp.queryAll = jest.fn().mockImplementation(async function* () {
      yield { pageNo: 1, rows: [{ CUSTOMER_CODE: 'A' }] };
    });
    await (build() as any).execute();
    expect(raw.clearStaleSeen).toHaveBeenCalled();
  });
});

/**
 * Recent-change catch-up during a backfill.
 *
 * The gap this closes, asked as a question: "if the ERP is updated, does the
 * data sync on time?" During a multi-day backfill it did not. A full sweep reads
 * oldest-first and earns no watermark until it finishes, so on 2026-09-20 —
 * sales_order 3,875 pages in, no watermark — a document edited that morning
 * would have waited days for the sweep to crawl up to it.
 */
describe('recent-change catch-up', () => {
  let raw: any;
  let erp: any;
  let config: any;
  let settings: Record<string, unknown>;

  const build = () => new CustomerIngestJob(raw, erp, config);

  /** A generator yielding one page of rows carrying the given timestamps. */
  const pageOf = (stamps: string[]) =>
    async function* () {
      yield {
        pageNo: 1,
        rows: stamps.map((s, i) => ({
          CUSTOMER_CODE: `C${i}`,
          LastModifiedDate: s,
        })),
      };
    };

  beforeEach(() => {
    settings = {
      ERP_INCREMENTAL: true,
      ERP_INCREMENTAL_FIELD: 'LastModifiedDate',
      ERP_PAGE_SIZE: 100,
      ERP_INCREMENTAL_OVERLAP_MINUTES: 30,
      ERP_CATCHUP: true,
      ERP_CATCHUP_MAX_MINUTES: 2,
      ERP_CATCHUP_LOOKBACK_HOURS: 48,
    };
    config = {
      get: (k: string) => settings[k],
      getOrThrow: (k: string) => settings[k],
    };
    raw = {
      tableFor: () => 'raw_customer',
      // startPage > 1 == a backfill is mid-flight, which is when catch-up runs.
      getIngestPage: jest.fn().mockResolvedValue(3875),
      setIngestPage: jest.fn(),
      clearIngestPage: jest.fn(),
      getWatermark: jest.fn().mockResolvedValue(null), // no watermark: still backfilling
      getCatchupWatermark: jest.fn().mockResolvedValue(null),
      setCatchupWatermark: jest.fn(),
      watermarkUpdatedAt: jest.fn().mockResolvedValue(new Date()),
      markFullSweep: jest.fn(),
      recordSeen: jest.fn(),
      seenCount: jest.fn().mockResolvedValue(10),
      rowCount: jest.fn().mockResolvedValue(10),
      deleteUnseen: jest.fn().mockResolvedValue(0),
      clearSeen: jest.fn(),
      clearStaleSeen: jest.fn(),
      setWatermark: jest.fn(),
      upsertMany: jest.fn().mockResolvedValue({ fetched: 2, changed: 2 }),
      linkCustomers: jest.fn(),
    };
    erp = {
      queryAll: jest.fn().mockImplementation(async function* () {}),
      // The ERP's own newest change, used to seed the first catch-up window.
      query: jest.fn().mockResolvedValue({
        rows: [{ LastModifiedDate: '2026-09-20 12:00:00' }],
      }),
    };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    Object.getPrototypeOf(CustomerIngestJob).incrementalUnavailable = false;
  });

  afterEach(() => jest.restoreAllMocks());

  it('pulls recent changes BEFORE continuing the backfill', async () => {
    await (build() as any).execute();

    // Two calls: the catch-up, then the backfill resuming at its page.
    expect(erp.queryAll).toHaveBeenCalledTimes(2);
    const [, catchupOpts] = erp.queryAll.mock.calls[0];
    expect(catchupOpts.conditions).toEqual([
      // 48 hours back from the ERP's own newest change, in the ERP's format.
      { field_name: 'LastModifiedDate', operator: '>=', value: '2026-09-18 12:00:00' },
    ]);
    // The backfill still resumes exactly where it paused.
    expect(erp.queryAll.mock.calls[1][2]).toBe(3875);
  });

  it("seeds the first window from the ERP's clock, never from ours", async () => {
    await (build() as any).execute();
    expect(erp.query).toHaveBeenCalledWith(
      ERP_METHOD.CUSTOMER_QUERY,
      expect.objectContaining({
        pageSize: 1,
        orders: [{ field_name: 'LastModifiedDate', order_type: 'desc' }],
      }),
    );
  });

  it('advances its own watermark from the newest row it actually saw', async () => {
    erp.queryAll.mockImplementationOnce(
      pageOf(['2026-09-20 09:00:00', '2026-09-20 11:30:00']),
    );
    await (build() as any).execute();
    expect(raw.setCatchupWatermark).toHaveBeenCalledWith(
      'ingest:customer',
      '2026-09-20 11:30:00',
    );
  });

  it('re-reads from the stored watermark, minus the overlap, on later turns', async () => {
    raw.getCatchupWatermark.mockResolvedValue('2026-09-20 11:30:00');
    await (build() as any).execute();
    const [, opts] = erp.queryAll.mock.calls[0];
    expect(opts.conditions).toEqual([
      { field_name: 'LastModifiedDate', operator: '>=', value: '2026-09-20 11:00:00' },
    ]);
    // No need to ask the ERP for its newest stamp once we have a position.
    expect(erp.query).not.toHaveBeenCalled();
  });

  it('keeps its own position, so it cannot move the sweep watermark', async () => {
    erp.queryAll.mockImplementationOnce(pageOf(['2026-09-20 11:30:00']));
    await (build() as any).execute();
    // The catch-up records where IT has read...
    expect(raw.setCatchupWatermark).toHaveBeenCalledWith(
      'ingest:customer',
      '2026-09-20 11:30:00',
    );
    // ...and never writes the sweep's watermark, which only a completed full
    // sweep may earn. Were it to, the backfill's remaining history would be
    // declared already seen.
    expect(raw.setWatermark).not.toHaveBeenCalledWith(
      'ingest:customer',
      '2026-09-20 11:30:00',
    );
  });

  it('does NOT run once the backfill is finished — the normal filter covers it', async () => {
    raw.getIngestPage.mockResolvedValue(1); // nothing mid-flight
    raw.getWatermark.mockResolvedValue('2026-09-20 10:00:00');
    await (build() as any).execute();
    expect(erp.queryAll).toHaveBeenCalledTimes(1); // the incremental sweep only
    expect(raw.getCatchupWatermark).not.toHaveBeenCalled();
  });

  it('can be switched off without touching the backfill', async () => {
    settings.ERP_CATCHUP = false;
    await (build() as any).execute();
    expect(erp.queryAll).toHaveBeenCalledTimes(1);
  });

  it('never falls back to an unfiltered re-read when the ERP rejects the filter', async () => {
    erp.queryAll.mockImplementationOnce(async function* () {
      throw new ErpApiError('CE66014:找不到别名为 LastModifiedDate 的查询列', {} as never);
    });
    await (build() as any).execute();
    // One extra full sweep would be a second multi-day read competing with the
    // first. The catch-up stands down instead.
    expect(erp.queryAll).toHaveBeenCalledTimes(2);
    expect(erp.queryAll.mock.calls[1][1].conditions).toBeUndefined();
    expect(raw.setCatchupWatermark).not.toHaveBeenCalled();
  });
});

/**
 * Deterministic page order.
 *
 * The failure this prevents, measured on 2026-09-22 against the production feed:
 * a customer sweep asked for 3,827 rows ordered by LastModifiedDate alone and
 * got back 3,827 rows containing only 3,727 distinct customer codes. Up to six
 * customers share one LastModifiedDate — the ERP bulk-updates them — so a tie
 * group straddling a page boundary was re-sent on the next page while another
 * row was never sent at all. The full sweep's reconciliation then deleted the
 * 100 customers it had not seen. They were never gone from the ERP.
 */
describe('sweep page order', () => {
  const build = (Job: any) => {
    const cfg: Record<string, unknown> = { ERP_INCREMENTAL_FIELD: 'LastModifiedDate',
      ERP_PAGE_SIZE: 100, ERP_PAGE_SIZE: 100 };
    const config = { get: (k: string) => cfg[k], getOrThrow: (k: string) => cfg[k] };
    return new Job({}, {}, config);
  };

  it('breaks ties on a unique field so pages cannot shuffle', () => {
    const order = (build(CustomerIngestJob) as any).sweepOrder();
    expect(order).toEqual([
      { field_name: 'LastModifiedDate', order_type: 'asc' },
      { field_name: 'CUSTOMER_CODE', order_type: 'asc' },
    ]);
  });

  it('keeps the modified date FIRST, so new work still lands at the end', () => {
    // Ascending-by-modified-date is what lets a days-long sweep resume safely:
    // freshly changed rows sort past the pages already walked. The tiebreaker
    // must not disturb that, so it comes second.
    const [primary] = (build(CustomerIngestJob) as any).sweepOrder();
    expect(primary).toEqual({ field_name: 'LastModifiedDate', order_type: 'asc' });
  });

  it('orders by the modified date alone when an object has no unique field', () => {
    // Not every object exposes one — sales_return has no subtable key at all.
    // Those keep the old single-field order rather than sorting on something
    // that is not actually unique, which would buy nothing.
    class NoTiebreaker extends (CustomerIngestJob as any) {
      sortTiebreaker = undefined;
    }
    expect((build(NoTiebreaker) as any).sweepOrder()).toEqual([
      { field_name: 'LastModifiedDate', order_type: 'asc' },
    ]);
  });
});
