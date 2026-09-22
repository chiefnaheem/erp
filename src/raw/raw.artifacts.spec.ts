import { Logger } from '@nestjs/common';
import { RawRepository } from './raw.repository';

/**
 * DCMS_ROWNUM is the row's POSITION in the result set, not part of the record.
 * The ERP only sends it when the query is ordered — which every sweep now is —
 * and it shifts whenever anything is inserted ahead of a row.
 */
describe('RawRepository.stripArtifacts', () => {
  it('removes DCMS_ROWNUM so a re-paged row is not seen as changed', () => {
    const page1 = { DOC_NO: 'X', CREDIT_AMT: 50000, DCMS_ROWNUM: 1095 };
    const page2 = { DOC_NO: 'X', CREDIT_AMT: 50000, DCMS_ROWNUM: 1096 }; // same record, later sweep

    expect(RawRepository.stripArtifacts(page1)).toEqual({ DOC_NO: 'X', CREDIT_AMT: 50000 });
    // Same content hash => the upsert is a no-op instead of rewriting the row.
    expect(RawRepository.hash(RawRepository.stripArtifacts(page1))).toBe(
      RawRepository.hash(RawRepository.stripArtifacts(page2)),
    );
  });

  it('without stripping, the same record hashes differently on every sweep', () => {
    // The bug this guards: ~1M sales-order rows rewritten per sweep, filling the disk.
    expect(RawRepository.hash({ DOC_NO: 'X', DCMS_ROWNUM: 1 })).not.toBe(
      RawRepository.hash({ DOC_NO: 'X', DCMS_ROWNUM: 2 }),
    );
  });

  it('leaves a row without artifacts untouched', () => {
    const row = { DOC_NO: 'X', CREDIT_AMT: 1 };
    expect(RawRepository.stripArtifacts(row)).toBe(row); // same reference, no copy
  });
});

/**
 * The resume cursor and the page size it is counted in.
 *
 * A page number is meaningless on its own: page 6,342 is row 634,100 at 100
 * rows per page and row 6,341,000 at 1,000. Changing ERP_PAGE_SIZE without
 * translating the cursor makes a sweep resume far past anything it has read and
 * leaves a hole in the history — which is exactly the symptom that started this:
 * raw_sales_order held nothing between July 2023 and September 2026.
 */
describe('ingest resume cursor across a page-size change', () => {
  let stored: string | null;
  let repo: any;

  beforeEach(() => {
    stored = null;
    const prisma = {
      $queryRaw: () => Promise.resolve(stored === null ? [] : [{ cursor_value: stored }]),
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        stored = String(values[1]);
        return Promise.resolve(1);
      },
      withRetry: (fn: () => Promise<unknown>) => fn(),
    };
    repo = new RawRepository(prisma as never);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('records the page size alongside the page', async () => {
    await repo.setIngestPage('ingest:sales_order', 635, 1000);
    expect(stored).toBe('635@1000');
  });

  it('returns the page unchanged when the size has not moved', async () => {
    await repo.setIngestPage('ingest:sales_order', 635, 1000);
    expect(await repo.getIngestPage('ingest:sales_order', 1000)).toBe(635);
  });

  it('translates on ROWS READ when the page size changes', async () => {
    // 6,342 pages of 100 = 634,100 rows read. At 1,000 per page that is page 635.
    await repo.setIngestPage('ingest:sales_order', 6342, 100);
    expect(await repo.getIngestPage('ingest:sales_order', 1000)).toBe(635);
  });

  it('translates back down again just as faithfully', async () => {
    await repo.setIngestPage('ingest:sales_order', 635, 1000);
    // 634 pages of 1,000 = 634,000 rows -> page 6,341 of 100.
    expect(await repo.getIngestPage('ingest:sales_order', 100)).toBe(6341);
  });

  it('rounds DOWN, so a partial page is re-read rather than skipped', async () => {
    // 15 pages of 100 = 1,400 rows. At 1,000 per page that is 1.4 pages —
    // resuming at page 2 would skip 400 rows, so it resumes at page 2's start.
    await repo.setIngestPage('ingest:customer_credit', 15, 100);
    const page = await repo.getIngestPage('ingest:customer_credit', 1000);
    expect(page).toBe(2);
    expect((page - 1) * 1000).toBeLessThanOrEqual(1400); // never past what was read
  });

  it('reads a legacy bare number as the historical 100-row default', async () => {
    stored = '6342'; // written before the size was recorded
    expect(await repo.getIngestPage('ingest:sales_order', 1000)).toBe(635);
  });

  it('starts at page 1 when there is no cursor at all', async () => {
    expect(await repo.getIngestPage('ingest:sales_order', 1000)).toBe(1);
  });
});
