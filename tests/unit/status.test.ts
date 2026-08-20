import { describe, it, expect } from 'vitest';
import { computeAnalysisStatus } from '$state/status';
import type { Analysis } from '$compiler/AbiAnalyzer';

const analysis = (over: Partial<Analysis>): Analysis =>
  ({
    code: 0,
    diagnosticsText: '',
    records: [],
    diagnostics: [],
    options: {},
    ...over,
  }) as unknown as Analysis;

describe('computeAnalysisStatus', () => {
  it('mirrors idle / running straight through', () => {
    expect(computeAnalysisStatus({ status: 'idle', error: null }, null, 0)).toEqual({
      kind: 'idle',
    });
    expect(computeAnalysisStatus({ status: 'running', error: null }, null, 0)).toEqual({
      kind: 'running',
    });
  });

  it('surfaces a thrown error message', () => {
    expect(
      computeAnalysisStatus({ status: 'error', error: new Error('worker died') }, null, 0),
    ).toEqual({ kind: 'error', message: 'worker died' });
  });

  it('ok + clean exit → ok, warnings from what clang reported', () => {
    expect(computeAnalysisStatus({ status: 'ok', error: null }, analysis({ code: 0 }), 2)).toEqual({
      kind: 'ok',
      warnings: false,
    });
    expect(
      computeAnalysisStatus(
        { status: 'ok', error: null },
        analysis({
          code: 0,
          diagnostics: [{ line: 1, column: 1, severity: 'warning', message: 'padded' }],
        }),
        2,
      ),
    ).toEqual({ kind: 'ok', warnings: true });
  });

  it('non-zero exit with no visible records → hard failure', () => {
    expect(computeAnalysisStatus({ status: 'ok', error: null }, analysis({ code: 1 }), 0)).toEqual({
      kind: 'error',
      message: 'compilation failed, see diagnostics',
    });
  });

  it('non-zero exit but records still shown → soft "compiled with errors"', () => {
    expect(computeAnalysisStatus({ status: 'ok', error: null }, analysis({ code: 1 }), 3)).toEqual({
      kind: 'error',
      message: 'compiled with errors, layouts may be incomplete',
    });
  });

  it('ok status but no analysis yet → idle', () => {
    expect(computeAnalysisStatus({ status: 'ok', error: null }, null, 0)).toEqual({ kind: 'idle' });
  });
});
