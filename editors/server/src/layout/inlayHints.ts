// The always-visible summary: `40 B · align 8 · 7 B padding` after each record's
// name, and with `members`, `@4 · 4 B` at the end of each member's line.
//
// Zed has no panels and Neovim's are text, so this is the one surface every
// editor shows without the user asking.

import type { Position, RecordView } from '../protocol.ts';
import { formatOffset, formatSizeShort } from './format.ts';

export type InlayHintsMode = 'records' | 'members' | 'off';

export interface LayoutHint {
  position: Position;
  label: string;
}

export function layoutHints(
  records: readonly RecordView[],
  mode: InlayHintsMode,
  lineLength: (line: number) => number,
): LayoutHint[] {
  if (mode === 'off') return [];
  const hints: LayoutHint[] = [];
  const hintedRecordLines = new Set<number>();
  for (const record of records) {
    // Several instantiations of one template share a declaration; one hint is enough.
    if (!record.nameRange || hintedRecordLines.has(record.nameRange.start.line)) continue;
    hintedRecordLines.add(record.nameRange.start.line);
    const parts = [formatSizeShort(record.sizeBits), `align ${record.alignBits / 8}`];
    if (record.paddingBytes) parts.push(`${record.paddingBytes} B padding`);
    hints.push({ position: record.nameRange.end, label: parts.join(' · ') });

    if (mode !== 'members') continue;
    // `int x, y;` declares two members on one line: one hint lists both.
    const byLine = new Map<number, string[]>();
    for (const member of record.members) {
      if (!member.nameRange) continue;
      const line = member.nameRange.start.line;
      const label = `@${formatOffset(member.offsetBits)} · ${formatSizeShort(member.sizeBits)}`;
      byLine.set(line, [...(byLine.get(line) ?? []), label]);
    }
    for (const [line, labels] of byLine) {
      hints.push({ position: { line, character: lineLength(line) }, label: labels.join(', ') });
    }
  }
  return hints;
}
