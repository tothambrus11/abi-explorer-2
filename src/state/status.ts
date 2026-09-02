// Pure mapping from the compile resource's state to the UI's AnalysisStatus.
// Extracted so the status logic is testable without runes or a live compiler.

import type { Analysis } from '$compiler/AbiAnalyzer';
import type { ResourceStatus } from './async-resource.svelte';
import type { AnalysisStatus } from './store.svelte';

/**
 * Derive the banner status from the compile resource plus the analysis it
 * produced. A non-zero exit with nothing to show is a hard failure; a non-zero
 * exit that still yielded records is a soft "compiled with errors".
 */
export function computeAnalysisStatus(
  resource: { status: ResourceStatus; error: unknown },
  analysis: Analysis | null,
  visibleCount: number,
): AnalysisStatus {
  switch (resource.status) {
    case 'idle':
      return { kind: 'idle' };
    case 'running':
      return { kind: 'running' };
    case 'error':
      return { kind: 'error', message: errorMessage(resource.error) };
    case 'ok':
      break;
  }
  if (!analysis) return { kind: 'idle' };
  if (analysis.code !== 0 && visibleCount === 0) {
    return { kind: 'error', message: 'compilation failed, see diagnostics' };
  }
  if (analysis.code !== 0) {
    return { kind: 'error', message: 'compiled with errors, layouts may be incomplete' };
  }
  return { kind: 'ok', warnings: analysis.diagnostics.length > 0 };
}

/** Something showable for any thrown value, including one that is not an Error. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}
