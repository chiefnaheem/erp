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
