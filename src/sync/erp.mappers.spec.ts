import { OrderStatus } from '@prisma/client';
import {
  VIJU_REGIONS,
  buildClusterRegionMap,
  buildStatusMap,
  toOrderStatus,
} from './erp.mappers';

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

describe('BP_CLUSTER_CODE → Region mapping', () => {
  it('maps the five Viju cluster codes out of the box', () => {
    const map = buildClusterRegionMap(undefined);
    expect(map).toEqual({
      '1': 'LAGOS',
      '2': 'EASTERN',
      '3': 'SOUTH_SOUTH',
      '4': 'WESTERN',
      '5': 'NORTH',
    });
  });

  it('leaves other-tenant cluster codes unmapped so they are quarantined', () => {
    // GZ020 alone accounts for 1,832 customers in the live feed — another
    // company on the same ERP. An unmapped code must resolve to nothing, never
    // to a default: Customer.region is NOT NULL and the portal filters on it.
    const map = buildClusterRegionMap(undefined);
    for (const code of ['GZ020', 'GZ001', '9', '', '0']) {
      expect(map[code]).toBeUndefined();
    }
  });

  it('lets ERP_CLUSTER_REGION_MAP remap a code and add a new one', () => {
    const map = buildClusterRegionMap('{"1":"NORTH","6":"LAGOS"}');
    expect(map['1']).toBe('NORTH');
    expect(map['6']).toBe('LAGOS');
  });

  it('accepts a region label case-insensitively and trims the code', () => {
    const map = buildClusterRegionMap('{" 7 ":"south_south"}');
    expect(map['7']).toBe('SOUTH_SOUTH');
  });

  it('refuses the WHOLE override when any value is not a real Region label', () => {
    // SOUTH_WEST is a retired label that no longer exists in the database enum.
    // Applying this override entry-by-entry would leave code 1 unmapped and
    // quarantine every LAGOS customer; a bad value would also abort the
    // projection statement at the ::"Region" cast. So the override is dropped
    // wholesale and the built-ins stand.
    const map = buildClusterRegionMap('{"1":"SOUTH_WEST","2":"EASTERN"}');
    expect(map).toEqual({
      '1': 'LAGOS',
      '2': 'EASTERN',
      '3': 'SOUTH_SOUTH',
      '4': 'WESTERN',
      '5': 'NORTH',
    });
  });

  it('REPLACES the built-ins when the override is entirely valid', () => {
    const map = buildClusterRegionMap('{"1":"LAGOS","9":"NORTH"}');
    expect(map).toEqual({ '1': 'LAGOS', '9': 'NORTH' });
    expect(map['2']).toBeUndefined();
  });

  it('falls back to the built-in map on unusable JSON', () => {
    expect(buildClusterRegionMap('{not json')['3']).toBe('SOUTH_SOUTH');
    expect(buildClusterRegionMap('{"1":"NOPE"}')['1']).toBe('LAGOS');
  });

  it('never contains a label outside the live database enum', () => {
    for (const region of Object.values(buildClusterRegionMap(undefined))) {
      expect(VIJU_REGIONS).toContain(region);
    }
  });
});
