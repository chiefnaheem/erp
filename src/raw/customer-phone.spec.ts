import { RawRepository } from './raw.repository';

/**
 * Harvesting customer phone numbers off documents.
 *
 * Why this exists at all: yvijucrm.customer.query carries one phone field,
 * PhoneNumber, and on 2026-09-21 it was blank for 3,825 of the 3,827 customers —
 * checked against the live ERP, not against our copy. The numbers that do exist
 * sit on sales_delivery / sales_return as TELEPHONE, and for the app a phone is
 * the login identifier and the OTP target, so a customer without one cannot sign
 * in at all.
 *
 * These pin the two properties that make the harvest safe to run from a sweep
 * that reads ten years of history oldest-first.
 */
describe('customer phone harvest', () => {
  let executed: { sql: string; params: unknown[] }[];
  let repo: RawRepository;

  beforeEach(() => {
    executed = [];
    const prisma = {
      $executeRawUnsafe: (sql: string, ...params: unknown[]) => {
        executed.push({ sql, params });
        return Promise.resolve(1);
      },
      withRetry: (fn: () => Promise<unknown>) => fn(),
    };
    repo = new RawRepository(prisma as never);
  });

  it('writes one row per customer, keeping the number off the NEWEST document', async () => {
    await repo.recordCustomerPhones([
      { code: '10110009', phone: '080-11111111', source: 'sales_delivery', docDate: '2016-04-04 00:00:00' },
      { code: '10110009', phone: '080-33335550', source: 'sales_delivery', docDate: '2026-08-04 00:00:00' },
      { code: '10110009', phone: '080-22222222', source: 'sales_delivery', docDate: '2019-01-01 00:00:00' },
    ]);

    expect(executed).toHaveLength(1);
    // One row, not three: a multi-row ON CONFLICT touching the same key twice is
    // rejected by Postgres outright.
    expect(executed[0].params).toEqual([
      '10110009',
      '080-33335550',
      'sales_delivery',
      '2026-08-04 00:00:00',
    ]);
  });

  it('refuses to walk a current number backwards through history', async () => {
    await repo.recordCustomerPhones([
      { code: '10110009', phone: '080-11111111', source: 'sales_delivery', docDate: '2016-04-04 00:00:00' },
    ]);
    // The backfill reads OLDEST-FIRST, so without this guard a 2016 delivery
    // arriving after a 2026 one would overwrite the current number.
    expect(executed[0].sql).toContain(
      'WHERE EXCLUDED.doc_date >= erp_raw.customer_phone.doc_date',
    );
  });

  it('drops rows with no code or no number instead of writing blanks', async () => {
    await repo.recordCustomerPhones([
      { code: '', phone: '08033335550', source: 'sales_delivery', docDate: '2026-01-01' },
      { code: '10110009', phone: '   ', source: 'sales_delivery', docDate: '2026-01-01' },
    ]);
    expect(executed).toHaveLength(0);
  });

  it('writes nothing at all for a page with no phones on it', async () => {
    await repo.recordCustomerPhones([]);
    expect(executed).toHaveLength(0);
  });
});
