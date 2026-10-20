// A layout drawn as an SVG, for hovers in editors that render images (VS Code
// and Zed both accept `data:image/svg+xml` in hover markdown). One image looks
// the same in both, and the same as the web explorer's layout view: its byte
// grid (bits where bit-fields are, stripes where union members share a byte,
// padding hatched, the hovered member outlined) and, for a record, its member
// table below. An image cannot follow the editor's theme, so it is drawn in
// the web's colours for the mode the client says (Nocturne's when dark), with
// labels in a grey that reads on either.

import type { ColorMode, RecordView } from '@abi-explorer/shared/protocol';
import { formatOffset, formatSizeShort } from '@abi-explorer/shared/format';
import {
  bytesPerRow,
  leafSize,
  mappedCells,
  NEUTRALS,
  paddingAfter,
  slotColor,
  type GridCell,
} from '@abi-explorer/shared/layoutModel';

/** The web grid's cell, wider than high (44 × 30 there), a 1 px gap of ground around it; smaller to fit a hover. */
const CELL_WIDTH = 36;
const CELL_HEIGHT = 24;
const LABEL_WIDTH = 36;
const HEADER_HEIGHT = 18;
const TABLE_GAP = 12;
const ROW_HEIGHT = 22;
/** Character advances at the table's sizes, for laying out its columns. */
const SANS_WIDTH = 6.6;
const MONO_WIDTH = 7.3;
/** Longer names and types are cut, so one long name does not widen the hover. */
const MAX_TEXT_LENGTH = 28;
const SANS = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "'JetBrains Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace";

export interface SvgOptions {
  /** The member to outline, as the web outlines a hovered one (an index into `members`). */
  highlightedMember?: number | null;
  /** Draw the member table below the map (a record's hover). */
  table?: boolean;
  /** The editor's theme. */
  mode?: ColorMode;
}

/** The colours a drawing uses. */
interface Palette {
  member: (slot: string) => string;
  n: (typeof NEUTRALS)['dark'];
}

export function svgMap(record: RecordView, options: SvgOptions = {}): string | null {
  const cells = mappedCells(record);
  if (!cells) return null;
  const index = options.highlightedMember ?? null;
  const member = index === null ? null : record.members[index];
  const lit = new Set(member?.leaves ?? []);
  const perRow = bytesPerRow(cells.length);
  const rows = Math.ceil(cells.length / perRow);
  const mode = options.mode ?? 'dark';
  const palette: Palette = { member: (slot) => slotColor(slot, mode), n: NEUTRALS[mode] };
  const defs = new Defs(palette);

  const parts: string[] = [];
  for (let column = 0; column < perRow; column++) {
    parts.push(
      text(
        palette,
        LABEL_WIDTH + column * CELL_WIDTH + CELL_WIDTH / 2,
        12,
        `+${column}`,
        'middle',
        11,
      ),
    );
  }
  for (const cell of cells) {
    const x = LABEL_WIDTH + (cell.byte % perRow) * CELL_WIDTH;
    const y = HEADER_HEIGHT + Math.floor(cell.byte / perRow) * CELL_HEIGHT;
    if (cell.byte % perRow === 0) {
      parts.push(
        text(palette, LABEL_WIDTH - 8, y + CELL_HEIGHT / 2 + 4, String(cell.byte), 'end', 11),
      );
    }
    parts.push(drawCell(record, cell, x, y, lit, defs, palette));
  }

  let width = LABEL_WIDTH + perRow * CELL_WIDTH;
  let height = HEADER_HEIGHT + rows * CELL_HEIGHT;
  if (options.table) {
    const table = memberTable(record, height + TABLE_GAP, palette);
    parts.push(...table.parts);
    width = Math.max(width, table.right);
    height = table.bottom;
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${height}" viewBox="0 0 ${Math.ceil(width)} ${height}" font-family="${SANS}" font-size="13">`,
    `<defs>${defs.toString()}</defs>`,
    ...parts,
    '</svg>',
  ].join('');
}

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** One byte: a member's colour, its bits, its members' stripes, or hatching; outlined when lit. */
function drawCell(
  record: RecordView,
  cell: GridCell,
  x: number,
  y: number,
  lit: ReadonlySet<number>,
  defs: Defs,
  palette: Palette,
): string {
  const { leaves } = record.layout;
  // The gap the web draws as a border in the ground's colour; 2 px where a member starts.
  const left = x + (cell.start ? 2 : 1);
  const top = y + 1;
  const width = x + CELL_WIDTH - 1 - left;
  const height = CELL_HEIGHT - 2;
  const out: string[] = [];
  if (cell.bits) {
    out.push(rect(left, top, width, height, palette.n.gridLine));
    const bit = (width - 7) / 8;
    cell.bits.forEach((owner, index) => {
      const bitLeft = left + index * (bit + 1);
      const starts = owner !== null && cell.byte * 8 + index === leaves[owner]!.offsetBits;
      const fill = owner === null ? `url(#${defs.hatch()})` : palette.member(leaves[owner]!.color);
      out.push(rect(bitLeft + (starts ? 1 : 0), top, bit - (starts ? 1 : 0), height, fill, 0));
      if (owner !== null && lit.has(owner)) out.push(outline(palette, bitLeft, top, bit, height));
    });
  } else {
    const fill =
      cell.leaves.length === 0
        ? `url(#${defs.hatch()})`
        : cell.leaves.length === 1
          ? palette.member(leaves[cell.leaves[0]!]!.color)
          : `url(#${defs.stripes(cell.leaves.slice(0, 3).map((index) => palette.member(leaves[index]!.color)))})`;
    out.push(rect(left, top, width, height, fill));
    if (cell.leaves.some((index) => lit.has(index))) {
      out.push(outline(palette, left, top, width, height));
    }
  }
  if (cell.band) {
    // A base subobject's bracket, as the web's inset band.
    const ink =
      palette.n.text === '#ffffff' ? 'rgba(255, 255, 255, 0.62)' : 'rgba(11, 11, 11, 0.62)';
    out.push(line(left, top + 1, left + width, top + 1, ink));
    out.push(line(left, top + height - 1, left + width, top + height - 1, ink));
    if (cell.band.first) out.push(line(left + 1, top, left + 1, top + height, ink));
    if (cell.band.last) out.push(line(left + width - 1, top, left + width - 1, top + height, ink));
  }
  return out.join('');
}

/** The web's field table, top-level rows: chip, field, type, offset, size, align, padding after. */
function memberTable(
  record: RecordView,
  top: number,
  palette: Palette,
): { parts: string[]; right: number; bottom: number } {
  const { layout } = record;
  const padAfter = paddingAfter(layout);
  const rows = layout.tree.map((node) => {
    if (node.kind === 'leaf') {
      const leaf = layout.leaves[node.ref]!;
      const pad = padAfter.get(node.ref);
      return {
        color: leaf.direct ? leaf.color : null,
        name: shorten(leaf.name),
        bold: false,
        type: shorten(leaf.kind === 'special' ? '-' : (leaf.type ?? '')),
        offset: formatOffset(leaf.offsetBits),
        size: leafSize(leaf),
        align: leaf.alignBits ? `${leaf.alignBits / 8} B` : '',
        pad: pad ? `+${pad} B` : '',
      };
    }
    const group = layout.groups[node.ref]!;
    return {
      color: group.direct ? group.color : null,
      name: shorten(group.name),
      bold: true,
      type: shorten(group.type),
      offset: formatOffset(group.offsetBits),
      size: formatSizeShort(group.sizeBits),
      align: group.alignBits ? `${group.alignBits / 8} B` : '',
      pad: '',
    };
  });
  const widest = (values: string[], advance: number) =>
    Math.max(...values.map((value) => value.length)) * advance;
  const columns = [
    { title: 'FIELD', width: widest(['FIELD', ...rows.map((row) => row.name)], MONO_WIDTH) },
    { title: 'TYPE', width: widest(['TYPE', ...rows.map((row) => row.type)], MONO_WIDTH) },
    { title: 'OFFSET', width: widest(['OFFSET', ...rows.map((row) => row.offset)], SANS_WIDTH) },
    { title: 'SIZE', width: widest(['SIZE', ...rows.map((row) => row.size)], SANS_WIDTH) },
    { title: 'ALIGN', width: widest(['ALIGN', ...rows.map((row) => row.align)], SANS_WIDTH) },
    {
      title: 'PADDING AFTER',
      width: widest(['PADDING AFTER', ...rows.map((row) => row.pad)], SANS_WIDTH),
    },
  ];
  const chip = 20;
  const lefts: number[] = [];
  let x = chip + 10;
  for (const column of columns) {
    lefts.push(x);
    x += column.width + 20;
  }
  const right = x - 10;
  const parts: string[] = [];
  columns.forEach((column, index) => {
    // Numbers are right-aligned under their heading, as in the web table.
    const numeric = index >= 2;
    parts.push(
      text(
        palette,
        numeric ? lefts[index]! + column.width : lefts[index]!,
        top + 12,
        column.title,
        numeric ? 'end' : 'start',
        11,
        ' font-weight="600" letter-spacing="0.5"',
      ),
    );
  });
  parts.push(line(0, top + 20, right, top + 20, palette.n.baseline));
  rows.forEach((row, index) => {
    const y = top + 21 + index * ROW_HEIGHT;
    const baseline = y + ROW_HEIGHT / 2 + 4;
    if (row.color) parts.push(rect(4, y + ROW_HEIGHT / 2 - 6, 12, 12, palette.member(row.color)));
    const cellsText = [row.name, row.type, row.offset, row.size, row.align, row.pad];
    cellsText.forEach((value, column) => {
      if (!value) return;
      const numeric = column >= 2;
      const extra =
        column === 0
          ? ` font-family="${MONO}"${row.bold ? ' font-weight="600"' : ''}`
          : column === 1
            ? ` font-family="${MONO}" font-size="12"`
            : '';
      parts.push(
        text(
          palette,
          numeric ? lefts[column]! + columns[column]!.width : lefts[column]!,
          baseline,
          escapeXml(value),
          numeric ? 'end' : 'start',
          undefined,
          extra,
          column === 5 ? palette.member('c-2') : undefined,
        ),
      );
    });
    parts.push(line(0, y + ROW_HEIGHT, right, y + ROW_HEIGHT, palette.n.gridLine));
  });
  return { parts, right, bottom: top + 21 + rows.length * ROW_HEIGHT + 1 };
}

/** Patterns the cells use, each defined once: padding's hatching, and each union's stripes. */
class Defs {
  private readonly entries = new Map<string, string>();
  private readonly palette: Palette;

  constructor(palette: Palette) {
    this.palette = palette;
  }

  hatch(): string {
    return this.add(
      'pad',
      (id) =>
        `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${this.palette.n.gridLine}"/><rect x="4" width="2" height="6" fill="${this.palette.n.baseline}"/></pattern>`,
    );
  }

  stripes(colors: string[]): string {
    const size = colors.length * 4;
    return this.add(
      `stripes-${colors.join('-').replaceAll('#', '')}`,
      (id) =>
        `<pattern id="${id}" width="${size}" height="${size}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">${colors.map((color, index) => `<rect x="${index * 4}" width="4" height="${size}" fill="${color}"/>`).join('')}</pattern>`,
    );
  }

  private add(id: string, define: (id: string) => string): string {
    if (!this.entries.has(id)) this.entries.set(id, define(id));
    return id;
  }

  toString(): string {
    return [...this.entries.values()].join('');
  }
}

function rect(
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  radius = 3,
): string {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}"${radius ? ` rx="${radius}"` : ''} fill="${fill}"/>`;
}

/** The web's hover: a 2 px outline inside the cell, in the page's ink. */
function outline(palette: Palette, x: number, y: number, width: number, height: number): string {
  return `<rect x="${round(x + 1)}" y="${round(y + 1)}" width="${round(width - 2)}" height="${round(height - 2)}" rx="2" fill="none" stroke="${palette.n.text}" stroke-width="2"/>`;
}

function line(x1: number, y1: number, x2: number, y2: number, stroke: string): string {
  return `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" stroke="${stroke}" stroke-width="${stroke.startsWith('rgba') ? 2 : 1}"/>`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function shorten(name: string): string {
  return name.length > MAX_TEXT_LENGTH ? name.slice(0, MAX_TEXT_LENGTH - 1) + '…' : name;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function text(
  palette: Palette,
  x: number,
  y: number,
  content: string,
  anchor = 'middle',
  size?: number,
  extra = '',
  fill?: string,
): string {
  fill ??= palette.n.muted;
  return `<text x="${round(x)}" y="${round(y)}" fill="${fill}" text-anchor="${anchor}"${size ? ` font-size="${size}"` : ''}${extra}>${content}</text>`;
}
