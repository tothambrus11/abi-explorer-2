// A layout drawn in monospace text, for hovers and panels that show no images.
//
//          0 1 2 3 4 5 6 7
//      0   a · · · b b b b
//      8   c c · · · · · ·
//
// One letter per member (the member table says which), `·` for padding. With
// a member highlighted, its bytes are `█`, other members `░`, padding `·`.

import type { RecordView } from '@abi-explorer/shared/protocol';
import { formatOffset, formatSizeShort } from '@abi-explorer/shared/format';
import {
  bytesPerRow,
  mappedBytes,
  layoutRows,
  memberLetter,
} from '@abi-explorer/shared/layoutModel';

export function textMap(
  record: RecordView,
  highlightedMember: number | null = null,
): string | null {
  const owners = mappedBytes(record);
  if (!owners) return null;
  const perRow = bytesPerRow(owners.length);
  const offsetWidth = String(owners.length - 1).length;
  const cellWidth = String(perRow - 1).length;

  const cell = (owner: number | null) => {
    if (owner === null) return '·';
    if (highlightedMember === null) return memberLetter(owner);
    return owner === highlightedMember ? '█' : '░';
  };

  const header =
    ' '.repeat(offsetWidth + 2) +
    range(perRow)
      .map((i) => String(i).padStart(cellWidth))
      .join(' ');
  const rows: string[] = [];
  for (let start = 0; start < owners.length; start += perRow) {
    const cells = owners
      .slice(start, start + perRow)
      .map((owner) => cell(owner).padStart(cellWidth));
    rows.push(`${String(start).padStart(offsetWidth)}  ${cells.join(' ')}`);
  }
  return [header, ...rows].join('\n');
}

/**
 * The member table in aligned columns, for clients that render no markdown
 * tables (terminals). `highlightedMember` gets a `▶`.
 *
 *     a  type      0   1 B  std::uint8_t
 *     ·  padding   1   3 B
 */
export function textMemberTable(
  record: RecordView,
  highlightedMember: number | null = null,
): string {
  const rows = layoutRows(record).map((row) => {
    if (row.kind === 'padding') {
      return [' ', '·', 'padding', formatOffset(row.offsetBits), formatSizeShort(row.sizeBits), ''];
    }
    const member = record.members[row.memberIndex]!;
    return [
      row.memberIndex === highlightedMember ? '▶' : ' ',
      memberLetter(row.memberIndex),
      member.label,
      formatOffset(member.offsetBits),
      formatSizeShort(member.sizeBits),
      member.type ?? '',
    ];
  });
  const width = (column: number) => Math.max(...rows.map((row) => row[column]!.length));
  return rows
    .map(([mark, letter, label, offset, size, type]) =>
      `${mark}${letter}  ${label!.padEnd(width(2))}  ${offset!.padStart(width(3))}  ${size!.padStart(width(4))}  ${type}`.trimEnd(),
    )
    .join('\n');
}

/** The byte map, then the member table: a record's whole layout as text. */
export function textLayout(record: RecordView, highlightedMember: number | null = null): string {
  return [textMap(record), textMemberTable(record, highlightedMember)].filter(Boolean).join('\n\n');
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
