import { OrderStatus } from '@prisma/client';
import { buildStatusMap, toOrderStatus } from './erp.mappers';

describe('ApproveStatus mapping', () => {
  it('maps the ERP default "Y" (approved) to PROCESSING out of the box', () => {
    const map = buildStatusMap(undefined);
    expect(toOrderStatus('Y', map)).toBe(OrderStatus.PROCESSING);
    expect(toOrderStatus('N', map)).toBe(OrderStatus.PENDING);
  });

  it('returns null for an unknown value so the caller skips it (never guesses)', () => {
    const map = buildStatusMap(undefined);
    expect(toOrderStatus('V', map)).toBeNull();
    expect(toOrderStatus('', map)).toBeNull();
    expect(toOrderStatus(undefined, map)).toBeNull();
  });

  it('lets ERP_STATUS_MAP override the defaults', () => {
    const map = buildStatusMap('{"Y":"DELIVERED","C":"CANCELLED"}');
    expect(toOrderStatus('Y', map)).toBe(OrderStatus.DELIVERED);
    expect(toOrderStatus('C', map)).toBe(OrderStatus.CANCELLED);
  });

  it('ignores an override value that is not a real OrderStatus, and bad JSON', () => {
    const bad = buildStatusMap('{"Y":"NOT_A_STATUS"}');
    // no valid entries → falls back to defaults
    expect(toOrderStatus('Y', bad)).toBe(OrderStatus.PROCESSING);

    const broken = buildStatusMap('{not json');
    expect(toOrderStatus('Y', broken)).toBe(OrderStatus.PROCESSING);
  });
});
