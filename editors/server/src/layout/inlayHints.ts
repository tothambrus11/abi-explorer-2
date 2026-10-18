// The always-visible summary: `40 B · align 8 · 7 B padding` after each record's
// name, and with `members`, `@4 · 4 B` at the end of each member's line.
//
// Zed has no panels and Neovim's are text, so this is the one surface every
// editor shows without the user asking.

import type { InlayHintsMode, Position, Range, RecordView } from '@abi-explorer/shared/protocol';
import { formatOffset, formatSizeShort } from '@abi-explorer/shared/format';
import { recordSummary } from '@abi-explorer/shared/layoutModel';

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
  // Member hints by line, across records: `int x, y;`, or a nested record and
  // the member of its type declared on one line, get one hint between them.
  const memberLines = new Map<number, { name: string; label: string }[]>();
  for (const record of records) {
    // Several instantiations of one template share a declaration; one hint is enough.
    if (!record.nameRange || hintedRecordLines.has(record.nameRange.start.line)) continue;
    hintedRecordLines.add(record.nameRange.start.line);
    hints.push({ position: record.nameRange.end, label: recordSummary(record) });

    if (mode !== 'members') continue;
    for (const member of record.members) {
      // A virtual base is named in another class's base list: its hint would land there.
      if (!member.nameRange || !within(member.nameRange.start, record.extent)) continue;
      const line = member.nameRange.start.line;
      const label = `@${formatOffset(member.offsetBits)} · ${formatSizeShort(member.sizeBits)}`;
      memberLines.set(line, [...(memberLines.get(line) ?? []), { name: member.label, label }]);
    }
  }
  for (const [line, members] of memberLines) {
    const label =
      members.length === 1
        ? members[0]!.label
        : members.map((member) => `${member.name} ${member.label}`).join(', ');
    hints.push({ position: { line, character: lineLength(line) }, label });
  }
  return hints;
}

function within(position: Position, range: Range | null): boolean {
  if (!range) return true;
  const after =
    position.line > range.start.line ||
    (position.line === range.start.line && position.character >= range.start.character);
  const before =
    position.line < range.end.line ||
    (position.line === range.end.line && position.character <= range.end.character);
  return after && before;
}
