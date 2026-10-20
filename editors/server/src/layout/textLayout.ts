// A layout drawn in Unicode, for hovers and panels that show no images: the
// web explorer's layout view in block characters.
//
//   ╭──────────╮ ╭──────────╮ ╭──────────╮
//   │ SIZEOF   │ │ ALIGNOF  │ │ PADDING  │
//   │ 16 bytes │ │ 8 bytes  │ │ 1 · 6%   │
//   ╰──────────╯ ╰──────────╯ ╰──────────╯
//
//        +0   +1   +2   +3   +4   +5   +6   +7
//     0  ▌▌▓▓ ▓▓▓▓ ████ ╱╱╱╱ ▓▓▓▓ ▓▓▓▓ ▓▓▓▓ ▓▓▓▓
//     8  ████ ████ ████ ████ ████ ████ ████ ████
//
// Four characters a byte, each two bits: a bit-field's byte shows where each
// field starts and ends (`▌` is two fields, one bit each). Members alternate
// `█` and `▓`, so neighbours stay apart without colour; padding is hatched
// `╱`, a byte several members share `▚`. Clients that colour the text
// (Neovim) get `colors`, which paint each member in the web's colours.

import type { RecordView, TextColor, TextRow } from '@abi-explorer/shared/protocol';
import { formatOffset, formatSizeShort } from '@abi-explorer/shared/format';
import {
  bytesPerRow,
  leafSize,
  mappedCells,
  nodeId,
  paddingAfter,
  visibleRows,
  type GridCell,
} from '@abi-explorer/shared/layoutModel';

const BYTE_WIDTH = 4;
/** Longer names and types are cut, so the table fits a split beside the code. */
const NAME_LENGTH = 24;
const TYPE_LENGTH = 18;
const PADDING = '╱';
const SHARED = '▚';
const HALVES = '▌';

export interface TextDrawing {
  text: string;
  colors: TextColor[];
  rows: TextRow[];
}

/** Lines and their colours, with colour columns in UTF-8 bytes. */
class Canvas {
  readonly lines: string[] = [];
  readonly colors: TextColor[] = [];

  /** Appends a line built from runs, each optionally coloured. */
  line(...runs: [string, string | null, string | null, string | null][]): number {
    const index = this.lines.length;
    let text = '';
    for (const [run, fg, bg, style] of runs) {
      const start = Buffer.byteLength(text);
      text += run;
      if ((fg || bg || style) && run) {
        this.colors.push([index, start, Buffer.byteLength(text), fg, bg, style]);
      }
    }
    this.lines.push(text);
    return index;
  }

  blank(): void {
    this.lines.push('');
  }

  /** Drops a line's trailing blanks, and any colour past them. */
  trim(index: number): void {
    const text = this.lines[index]!.trimEnd();
    this.lines[index] = text;
    const end = Buffer.byteLength(text);
    for (const color of this.colors) {
      if (color[0] === index) color[2] = Math.min(color[2], end);
    }
  }
}

type Run = [string, string | null, string | null, string | null];

/**
 * The whole view: size tiles, byte grid, member table. `highlightedMember`
 * (an index into `members`) is the member at the caret; `open` the table rows
 * opened, by node id.
 */
export function textLayout(
  record: RecordView,
  highlightedMember: number | null = null,
  open: ReadonlySet<string> = new Set(),
): TextDrawing {
  const canvas = new Canvas();
  tiles(canvas, record);
  const lit = new Set(
    highlightedMember === null ? [] : (record.members[highlightedMember]?.leaves ?? []),
  );
  const cells = mappedCells(record);
  if (cells) {
    canvas.blank();
    grid(canvas, record, cells, lit);
  }
  canvas.blank();
  const rows = table(canvas, record, lit, open);
  return { text: canvas.lines.join('\n'), colors: canvas.colors, rows };
}

/**
 * The byte grid alone, without colour, for a member's hover in a client that
 * shows no images: the member's bytes `█`, the others' `░`, padding `╱`.
 */
export function textMap(
  record: RecordView,
  highlightedMember: number | null = null,
): string | null {
  const cells = mappedCells(record);
  if (!cells) return null;
  const canvas = new Canvas();
  const lit =
    highlightedMember === null ? null : new Set(record.members[highlightedMember]?.leaves ?? []);
  grid(canvas, record, cells, lit ?? new Set(), lit);
  return canvas.lines.join('\n');
}

/** The web's SIZEOF, ALIGNOF and PADDING tiles, boxed. */
function tiles(canvas: Canvas, record: RecordView): void {
  const size = record.sizeBits / 8;
  const padding = record.paddingBytes;
  const entries = [
    { label: 'SIZEOF', value: String(size), unit: bytes(size), warn: false },
    {
      label: 'ALIGNOF',
      value: String(record.alignBits / 8),
      unit: bytes(record.alignBits / 8),
      warn: false,
    },
    {
      label: 'PADDING',
      value: padding === null ? '-' : String(padding),
      unit:
        padding === null
          ? 'not measured'
          : `${bytes(padding)}${size ? ` · ${Math.round((100 * padding) / size)}%` : ''}`,
      warn: padding !== null && padding > 0,
    },
  ];
  const widths = entries.map((entry) =>
    Math.max(entry.label.length, entry.value.length + 1 + entry.unit.length),
  );
  const row = (parts: (index: number, width: number) => Run[]) =>
    canvas.line(
      ...entries.flatMap((_, index): Run[] => [
        ...(index > 0 ? [[' ', null, null, null] as Run] : []),
        ...parts(index, widths[index]!),
      ]),
    );
  row((_, width) => [[`╭${'─'.repeat(width + 2)}╮`, 'baseline', null, null]]);
  row((index, width) => [
    ['│ ', 'baseline', null, null],
    [entries[index]!.label.padEnd(width), 'muted', null, null],
    [' │', 'baseline', null, null],
  ]);
  row((index, width) => {
    const entry = entries[index]!;
    return [
      ['│ ', 'baseline', null, null],
      [entry.value, entry.warn ? 'c-2' : 'text', null, 'bold'],
      [` ${entry.unit}`.padEnd(width - entry.value.length), 'muted', null, null],
      [' │', 'baseline', null, null],
    ];
  });
  row((_, width) => [[`╰${'─'.repeat(width + 2)}╯`, 'baseline', null, null]]);
  const extras: string[] = [];
  if (record.dataSizeBits !== record.sizeBits) extras.push(`dsize ${record.dataSizeBits / 8} B`);
  if (record.nonVirtualSizeBits !== record.sizeBits) {
    extras.push(`nvsize ${record.nonVirtualSizeBits / 8} B`);
  }
  if (record.nonVirtualAlignBits !== record.alignBits) {
    extras.push(`nvalign ${record.nonVirtualAlignBits / 8} B`);
  }
  if (record.preferredAlignBits !== record.alignBits) {
    extras.push(`preferred align ${record.preferredAlignBits / 8} B`);
  }
  if (extras.length) canvas.line([extras.join(' · '), 'muted', null, null]);
}

function bytes(count: number): string {
  return count === 1 ? 'byte' : 'bytes';
}

/**
 * The grid. With `shadeOnly`, the plain hover's shading: those leaves `█`,
 * everything else `░`; otherwise members alternate `█`/`▓` and the leaves in
 * `lit` are marked for an outline.
 */
function grid(
  canvas: Canvas,
  record: RecordView,
  cells: GridCell[],
  lit: ReadonlySet<number>,
  shadeOnly: ReadonlySet<number> | null = null,
): void {
  const { leaves } = record.layout;
  const perRow = bytesPerRow(cells.length);
  const labelWidth = Math.max(2, String(cells.length - 1).length);
  const glyph = (leaf: number | null): string => {
    if (leaf === null) return PADDING;
    if (shadeOnly) return shadeOnly.has(leaf) ? '█' : '░';
    const color = leaves[leaf]!.color;
    if (color === 'c-special') return '▒';
    return Number(color.slice(2)) % 2 === 1 ? '█' : '▓';
  };
  // Padding is hatched in the grid's lines, as on the web.
  const colorOf = (leaf: number | null) => (leaf === null ? 'baseline' : leaves[leaf]!.color);
  const groundOf = (leaf: number | null) => (leaf === null ? 'grid' : leaves[leaf]!.color);

  canvas.line([
    ' '.repeat(labelWidth + 2) +
      Array.from({ length: perRow }, (_, column) => `+${column}`.padEnd(BYTE_WIDTH))
        .join(' ')
        .trimEnd(),
    'muted',
    null,
    null,
  ]);
  for (let start = 0; start < cells.length; start += perRow) {
    const runs: Run[] = [[`${String(start).padStart(labelWidth)}  `, 'muted', null, null]];
    cells.slice(start, start + perRow).forEach((cell, index) => {
      if (index > 0) runs.push([' ', null, null, null]);
      const style = cell.leaves.some((leaf) => lit.has(leaf)) && !shadeOnly ? 'lit' : null;
      if (cell.bits) {
        // Two bits a character: the left half is the first.
        for (let pair = 0; pair < BYTE_WIDTH; pair++) {
          const first = cell.bits[pair * 2] ?? null;
          const second = cell.bits[pair * 2 + 1] ?? null;
          const pairStyle =
            (first !== null && lit.has(first)) || (second !== null && lit.has(second))
              ? style
              : null;
          if (first === second) {
            runs.push([glyph(first), colorOf(first), groundOf(first), pairStyle]);
          } else {
            runs.push([HALVES, groundOf(first), groundOf(second), pairStyle]);
          }
        }
      } else if (cell.leaves.length === 0) {
        runs.push([PADDING.repeat(BYTE_WIDTH), 'baseline', 'grid', null]);
      } else if (cell.leaves.length === 1) {
        const leaf = cell.leaves[0]!;
        runs.push([glyph(leaf).repeat(BYTE_WIDTH), colorOf(leaf), groundOf(leaf), style]);
      } else {
        const [first, second] = cell.leaves as [number, number];
        runs.push([
          shadeOnly
            ? glyph(cell.leaves.find((leaf) => shadeOnly.has(leaf)) ?? first).repeat(BYTE_WIDTH)
            : SHARED.repeat(BYTE_WIDTH),
          leaves[first]!.color,
          leaves[second]!.color,
          style,
        ]);
      }
    });
    canvas.line(...runs);
    // A line between rows, as the web's cells have ground around them.
    if (start + perRow < cells.length) canvas.blank();
  }
}

/** The web's field table: chip, field, type, offset, size, align, padding after; nested rows indented. */
function table(
  canvas: Canvas,
  record: RecordView,
  lit: ReadonlySet<number>,
  open: ReadonlySet<string>,
): TextRow[] {
  const { layout } = record;
  const padAfter = paddingAfter(layout);
  const rows = visibleRows(layout.tree, open).map(({ node, depth }) => {
    const indent = '  '.repeat(depth);
    if (node.kind === 'leaf') {
      const leaf = layout.leaves[node.ref]!;
      const pad = padAfter.get(node.ref);
      return {
        node,
        color: leaf.direct ? leaf.color : null,
        twist: ' ',
        name: indent + shorten(leaf.name, NAME_LENGTH),
        tags: '',
        type: shorten(leaf.kind === 'special' ? '-' : (leaf.type ?? ''), TYPE_LENGTH),
        offset: formatOffset(leaf.offsetBits),
        size: leafSize(leaf),
        align: leaf.alignBits ? `${leaf.alignBits / 8} B` : '',
        pad: pad ? `+${pad} B` : '',
        lit: lit.has(node.ref),
        range: leaf.nameRange,
      };
    }
    const group = layout.groups[node.ref]!;
    const opens = node.children.length > 0;
    const tags = [
      group.isBase ? 'BASE' : '',
      group.isUnion ? 'UNION' : '',
      node.overlaps ? 'OVERLAPS' : '',
    ].filter(Boolean);
    return {
      node,
      color: group.direct ? group.color : null,
      twist: opens ? (open.has(nodeId(node)) ? '▾' : '▸') : ' ',
      name: indent + shorten(group.name, NAME_LENGTH),
      tags: tags.length ? ` ${tags.join(' ')}` : '',
      type: shorten(group.type, TYPE_LENGTH),
      offset: formatOffset(group.offsetBits),
      size: formatSizeShort(group.sizeBits) + (group.sizeBits < group.typeSizeBits ? ' *' : ''),
      align: group.alignBits ? `${group.alignBits / 8} B` : '',
      pad: '',
      lit: group.leafIndexes.length > 0 && group.leafIndexes.every((index) => lit.has(index)),
      range: group.nameRange,
    };
  });
  const width = (pick: (row: (typeof rows)[number]) => string, title: string) =>
    Math.max(title.length, ...rows.map((row) => Array.from(pick(row)).length));
  const nameWidth = width((row) => row.twist + ' ' + row.name + row.tags, '  FIELD');
  const typeWidth = width((row) => row.type, 'TYPE');
  const offsetWidth = width((row) => row.offset, 'OFFSET');
  const sizeWidth = width((row) => row.size, 'SIZE');
  const alignWidth = width((row) => row.align, 'ALIGN');
  const padWidth = width((row) => row.pad, 'PADDING AFTER');
  const pad = (value: string, size: number) =>
    value + ' '.repeat(Math.max(0, size - Array.from(value).length));
  const padStart = (value: string, size: number) =>
    ' '.repeat(Math.max(0, size - Array.from(value).length)) + value;

  canvas.line([
    `   ${pad('  FIELD', nameWidth)}  ${pad('TYPE', typeWidth)}  ${padStart('OFFSET', offsetWidth)}  ${padStart('SIZE', sizeWidth)}  ${padStart('ALIGN', alignWidth)}  ${padStart('PADDING AFTER', padWidth)}`.trimEnd(),
    'muted',
    null,
    null,
  ]);
  const out: TextRow[] = [];
  for (const row of rows) {
    const style = row.lit ? 'lit' : null;
    const nameText = `${row.twist} ${row.name}`;
    const line = canvas.line(
      [' ', null, null, null],
      [row.color ? '■' : ' ', row.color, null, null],
      [' ', null, null, null],
      [
        nameText,
        row.node.kind === 'group' ? 'text' : null,
        null,
        row.node.kind === 'group' ? 'bold' : null,
      ],
      [row.tags, 'muted', null, null],
      [
        ' '.repeat(Math.max(0, nameWidth - Array.from(nameText + row.tags).length)) + '  ',
        null,
        null,
        null,
      ],
      [pad(row.type, typeWidth), 'muted', null, null],
      [
        `  ${padStart(row.offset, offsetWidth)}  ${padStart(row.size, sizeWidth)}  ${padStart(row.align, alignWidth)}`,
        null,
        null,
        null,
      ],
      [row.pad ? `  ${padStart(row.pad, padWidth)}` : '', 'c-2', null, null],
    );
    canvas.trim(line);
    // The member at the caret: its whole row tinted, as the web tints a hovered row.
    if (style) {
      canvas.colors.push([line, 0, Buffer.byteLength(canvas.lines[line]!), null, null, 'lit-row']);
    }
    out.push({
      line,
      id: nodeId(row.node),
      opens: row.node.children.length > 0,
      range: row.range,
    });
  }
  for (const marker of layout.markers) {
    if (marker.kind !== 'zero-bitfield') continue;
    canvas.line([
      `     ${'  '.repeat(marker.path.length)}${marker.type} :0 (unit break)  ${formatOffset(marker.offsetBits)}`,
      'muted',
      null,
      null,
    ]);
  }
  return out;
}

function shorten(text: string, length: number): string {
  return text.length > length ? text.slice(0, length - 1) + '…' : text;
}
