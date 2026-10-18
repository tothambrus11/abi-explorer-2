// A layout drawn as an SVG, for hovers in editors that render images (VS Code
// and Zed both accept `data:image/svg+xml` in hover markdown). One image looks
// the same in both, and carries the colours a markdown table cannot.
//
// The byte map is one cell per byte, each member a colour and its letter,
// padding hatched, as in the panel; beside it, the member table with the same
// swatches. The colours are mid-tone so the image reads on light and dark
// themes alike; an image cannot follow the editor's theme.

import type { RecordView } from '@abi-explorer/shared/protocol';
import { formatOffset, formatSizeShort } from '@abi-explorer/shared/format';
import {
  bytesPerRow,
  layoutRows,
  mappedBytes,
  memberColor,
  memberLetter,
  PADDING_COLOR,
} from '@abi-explorer/shared/layoutModel';

const CELL = 22;
const GAP = 2;
const LABEL_WIDTH = 34;
const HEADER_HEIGHT = 16;
/** Monospace advance at the 12px font size, for laying out the table's columns. */
const CHAR_WIDTH = 7.3;
const TABLE_GAP = 24;
const ROW_HEIGHT = 20;
const SWATCH = 16;
/** Longer member names are cut, so one long name does not widen the hover. */
const MAX_NAME_LENGTH = 22;

export interface SvgOptions {
  /** The member to show in full colour, the others faded (a member's hover). */
  highlightedMember?: number | null;
  /** Draw the member table beside the map (a record's hover). */
  table?: boolean;
}

export function svgMap(record: RecordView, options: SvgOptions = {}): string | null {
  const highlighted = options.highlightedMember ?? null;
  const owners = mappedBytes(record, highlighted);
  if (!owners) return null;
  const perRow = bytesPerRow(owners.length);
  const rows = Math.ceil(owners.length / perRow);
  const mapWidth = LABEL_WIDTH + perRow * (CELL + GAP);
  const mapHeight = HEADER_HEIGHT + rows * (CELL + GAP);

  const parts: string[] = [];
  for (let column = 0; column < perRow; column++) {
    parts.push(
      text(LABEL_WIDTH + column * (CELL + GAP) + CELL / 2, 11, String(column), PADDING_COLOR),
    );
  }
  owners.forEach((owner, byte) => {
    const x = LABEL_WIDTH + (byte % perRow) * (CELL + GAP);
    const y = HEADER_HEIGHT + Math.floor(byte / perRow) * (CELL + GAP);
    if (byte % perRow === 0) {
      parts.push(text(LABEL_WIDTH - 6, y + CELL / 2 + 4, String(byte), PADDING_COLOR, 'end'));
    }
    parts.push(swatch(x, y, CELL, owner, highlighted !== null && owner !== highlighted));
  });

  let width = mapWidth;
  let height = mapHeight;
  if (options.table) {
    const table = memberTable(record, mapWidth + TABLE_GAP);
    parts.push(...table.parts);
    width = table.right;
    height = Math.max(height, table.bottom);
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${height}" viewBox="0 0 ${Math.ceil(width)} ${height}" font-family="Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="12">`,
    `<defs><pattern id="pad" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="${PADDING_COLOR}" fill-opacity="0.15"/><line x1="0" y1="0" x2="0" y2="4" stroke="${PADDING_COLOR}" stroke-width="1.5" stroke-opacity="0.6"/></pattern></defs>`,
    ...parts,
    '</svg>',
  ].join('');
}

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** Swatch, name, offset and size per row, as the panel's table reads. */
function memberTable(
  record: RecordView,
  left: number,
): { parts: string[]; right: number; bottom: number } {
  const rows = layoutRows(record).map((row) =>
    row.kind === 'padding'
      ? {
          owner: null,
          name: 'padding',
          offset: formatOffset(row.offsetBits),
          size: formatSizeShort(row.sizeBits),
        }
      : {
          owner: row.memberIndex,
          name: shorten(record.members[row.memberIndex]!.label),
          offset: formatOffset(row.offsetBits),
          size: formatSizeShort(row.sizeBits),
        },
  );
  const columns = (key: 'name' | 'offset' | 'size', title: string) =>
    Math.max(title.length, ...rows.map((row) => row[key].length)) * CHAR_WIDTH;
  const nameX = left + SWATCH + 8;
  const offsetRight = nameX + columns('name', 'Member') + 12 + columns('offset', 'Offset');
  const sizeRight = offsetRight + 12 + columns('size', 'Size');

  const parts = [
    text(nameX, 11, 'Member', PADDING_COLOR, 'start'),
    text(offsetRight, 11, 'Offset', PADDING_COLOR, 'end'),
    text(sizeRight, 11, 'Size', PADDING_COLOR, 'end'),
  ];
  rows.forEach((row, index) => {
    const y = HEADER_HEIGHT + index * ROW_HEIGHT;
    const baseline = y + SWATCH / 2 + 4;
    const style = row.owner === null ? ' font-style="italic"' : '';
    parts.push(
      swatch(left, y, SWATCH, row.owner, false),
      text(nameX, baseline, escapeXml(row.name), PADDING_COLOR, 'start', style),
      text(offsetRight, baseline, row.offset, PADDING_COLOR, 'end'),
      text(sizeRight, baseline, row.size, PADDING_COLOR, 'end'),
    );
  });
  return { parts, right: sizeRight + 2, bottom: HEADER_HEIGHT + rows.length * ROW_HEIGHT };
}

/** A member's cell: its colour and letter, faded when another member is the point; padding hatched (fainter then too). */
function swatch(x: number, y: number, size: number, owner: number | null, faded: boolean): string {
  if (owner === null) {
    return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="3" fill="url(#pad)"${faded ? ' opacity="0.5"' : ''}/>`;
  }
  const color = memberColor(owner);
  return (
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="3" fill="${color}"${faded ? ' fill-opacity="0.15"' : ''}/>` +
    text(x + size / 2, y + size / 2 + 4, memberLetter(owner), faded ? color : '#ffffff')
  );
}

function shorten(name: string): string {
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH - 1) + '…' : name;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function text(
  x: number,
  y: number,
  content: string,
  fill: string,
  anchor = 'middle',
  extra = '',
): string {
  return `<text x="${x}" y="${y}" fill="${fill}" text-anchor="${anchor}"${extra}>${content}</text>`;
}
