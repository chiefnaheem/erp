import {
  CustomerCreditIngestJob,
  SalesOrderIngestJob,
} from './jobs/ingest.jobs';

/**
 * Raw rows are keyed on the ERP's own identifier. When that identifier is not
 * actually unique, two different records collapse onto one and the second is
 * lost silently — no error, just missing data. All three cases below were
 * measured against the live feed.
 */
describe('ingest keys are unique per record', () => {
  const keyOf = (job: any, row: Record<string, unknown>) => job.keyOf(row);
  const build = (C: any) => new C({} as never, {} as never, {} as never);

  describe('customer_credit', () => {
    const job = build(CustomerCreditIngestJob);

    it('keeps two real records that differ ONLY in the amount', () => {
      // Customer 10110007: same id, same effective date, two genuinely different
      // credit records (the ERP team confirmed). Keying without the amount kept
      // one and silently dropped the other.
      const big = {
        CUSTOMER_CREDIT_ID: 'f097a5ca-4a3a-4d84-8417-123b327bcce6',
        EFFECTIVE_DATE: '2026-09-02 00:00:00',
        CREDIT_AMT1: 100000000,
      };
      const small = { ...big, CREDIT_AMT1: 2000 };
      expect(keyOf(job, big)).not.toBe(keyOf(job, small));
    });

    it('separates two credit PERIODS that share one CUSTOMER_CREDIT_ID', () => {
      // Real rows for customer 20410008: same id, different validity periods.
      const july = {
        CUSTOMER_CREDIT_ID: 'f469d93b-0f26-4ef9-b3a2-1d9e7ccbe78a',
        EFFECTIVE_DATE: '2026-07-01 00:00:00',
        CREDIT_AMT1: 20000,
      };
      const august = {
        CUSTOMER_CREDIT_ID: 'f469d93b-0f26-4ef9-b3a2-1d9e7ccbe78a',
        EFFECTIVE_DATE: '2026-07-28 00:00:00',
        CREDIT_AMT1: 10000,
      };
      expect(keyOf(job, july)).not.toBe(keyOf(job, august));
    });

    it('keeps the same key when a NON-key field is edited', () => {
      const before = { CUSTOMER_CREDIT_ID: 'id-1', EFFECTIVE_DATE: '2026-07-01 00:00:00', CREDIT_AMT: 1, CREDIT_AMT1: 500 };
      const after = { ...before, CREDIT_AMT: 2, CREDIT_PAY: 99 };
      expect(keyOf(job, before)).toBe(keyOf(job, after)); // an update, not a new row
    });

    it('changing CREDIT_AMT1 makes a new key — safe only because this object sweeps in full', () => {
      // Documented trade-off: the ghost this leaves is deleted by the
      // reconciliation that every full sweep performs.
      const before = { CUSTOMER_CREDIT_ID: 'id-1', EFFECTIVE_DATE: '2026-07-01 00:00:00', CREDIT_AMT1: 500 };
      const after = { ...before, CREDIT_AMT1: 5500 };
      expect(keyOf(job, before)).not.toBe(keyOf(job, after));
    });
  });

  describe('sales_order', () => {
    const job = build(SalesOrderIngestJob);
    const ZERO = '00000000-0000-0000-0000-000000000000';

    it('does not collapse every detail-less order onto the zero GUID', () => {
      const a = { SALES_ORDER_DOC_D_ID: ZERO, DOC_NO: '2310-0001' };
      const b = { SALES_ORDER_DOC_D_ID: ZERO, DOC_NO: '2310-0002' };
      expect(keyOf(job, a)).not.toBe(keyOf(job, b));
      expect(keyOf(job, a)).toBe('2310-0001'); // falls back to the document number
    });

    it('separates sub-lines that share one detail id', () => {
      const first = { SALES_ORDER_DOC_D_ID: '56c7cda0', SequenceNumber1: 1, BUSINESS_QTY1: 4 };
      const second = { SALES_ORDER_DOC_D_ID: '56c7cda0', SequenceNumber1: 2, BUSINESS_QTY1: 60 };
      expect(keyOf(job, first)).not.toBe(keyOf(job, second));
    });

    it('uses the detail id alone when there is no sub-line', () => {
      expect(keyOf(job, { SALES_ORDER_DOC_D_ID: 'abc', DOC_NO: 'X' })).toBe('abc');
    });

    it('returns undefined when there is nothing to key on', () => {
      expect(keyOf(job, { SALES_ORDER_DOC_D_ID: ZERO })).toBeUndefined();
    });
  });
});

/**
 * The 2026-09-07 doc update added the SUBTABLE (line items) to sales_delivery and
 * sales_return. Both now arrive as one row per line, so the old header-level keys
 * silently kept a single line per document.
 */
describe('line-level keys after the 2026-09-07 subtable update', () => {
  const {
    SalesDeliveryIngestJob,
    SalesReturnIngestJob,
  } = require('./jobs/ingest.jobs');
  const build = (C: any) => new C({} as never, {} as never, {} as never);
  const keyOf = (job: any, row: Record<string, unknown>) => job.keyOf(row);
  const ZERO = '00000000-0000-0000-0000-000000000000';

  describe('sales_delivery', () => {
    const job = build(SalesDeliveryIngestJob);

    it('keeps every LINE of one delivery (measured: 1,200 rows, 275 DOC_NOs)', () => {
      const doc = { DOC_NO: '2503-2016041300001' };
      const a = { ...doc, SALES_DELIVERY_D_ID: '9c0c1bd8-line-a', ITEM_CODE: '103010102' };
      const b = { ...doc, SALES_DELIVERY_D_ID: '9c0c1bd8-line-b', ITEM_CODE: '101011701' };
      expect(keyOf(job, a)).not.toBe(keyOf(job, b));
    });

    it('falls back to DOC_NO for a detail-less delivery (zero GUID)', () => {
      const a = { SALES_DELIVERY_D_ID: ZERO, DOC_NO: 'D-1' };
      const b = { SALES_DELIVERY_D_ID: ZERO, DOC_NO: 'D-2' };
      expect(keyOf(job, a)).toBe('D-1');
      expect(keyOf(job, a)).not.toBe(keyOf(job, b));
    });
  });

  describe('sales_return', () => {
    const job = build(SalesReturnIngestJob);
    const line = (over: Record<string, unknown>) => ({
      DOC_NO: '2700-201712030002',
      ITEM_CODE: '101011701',
      LOT_CODE: '',
      PRICE: 14700,
      BUSINESS_QTY: 35,
      AMOUNT: 514500,
      ...over,
    });

    it('keeps lines that differ only in quantity/amount', () => {
      // Real collision: same document, item and lot; different quantity.
      const first = line({});
      const second = line({ BUSINESS_QTY: 12, AMOUNT: 176400 });
      expect(keyOf(job, first)).not.toBe(keyOf(job, second));
    });

    it('gives the same key to the same line seen twice (so it updates, not duplicates)', () => {
      expect(keyOf(job, line({}))).toBe(keyOf(job, line({})));
    });

    it('ignores header-only changes when identifying a line', () => {
      // A header field moving must not orphan the line's row.
      expect(keyOf(job, line({}))).toBe(keyOf(job, line({ RECEIPTED_STATUS: 'Y' })));
    });

    it('returns undefined without a document number', () => {
      expect(keyOf(job, { ITEM_CODE: 'x' })).toBeUndefined();
    });
  });
});
