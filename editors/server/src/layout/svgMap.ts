// A layout drawn as an SVG grid, for hovers in editors that render images
// (VS Code and Zed both accept `data:image/svg+xml` in hover markdown).
//
// Same cells as the text map: one per byte, each member a colour and its
// letter, padding hatched. The colours are mid-tone so the image reads on light
// and dark themes alike; an image cannot follow the editor's theme.

import type { RecordView } from '@abi-explorer/shared/protocol';
import {
  bytesPerRow,
  mappedBytes,
  memberColor,
  memberLetter,
  PADDING_COLOR,
} from '@abi-explorer/shared/layoutModel';

const CELL = 22;
const GAP = 2;
const LABEL_WIDTH = 34;
const HEADER_HEIGHT = 16;

export function svgMap(record: RecordView, highlightedMember: number | null = null): string | null {
  const owners = mappedBytes(record);
  if (!owners) return null;
  const perRow = bytesPerRow(owners.length);
  const rows = Math.ceil(owners.length / perRow);
  const width = LABEL_WIDTH + perRow * (CELL + GAP);
  const height = HEADER_HEIGHT + rows * (CELL + GAP);

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="12">`,
    `<defs><pattern id="pad" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="${PADDING_COLOR}" fill-opacity="0.15"/><line x1="0" y1="0" x2="0" y2="4" stroke="${PADDING_COLOR}" stroke-width="1.5" stroke-opacity="0.6"/></pattern></defs>`,
  ];
  for (let column = 0; column < perRow; column++) {
    parts.push(
      text(LABEL_WIDTH + column * (CELL + GAP) + CELL / 2, 11, String(column), PADDING_COLOR),
    );
  }
  owners.forEach((owner, byte) => {
    const row = Math.floor(byte / perRow);
    const x = LABEL_WIDTH + (byte % perRow) * (CELL + GAP);
    const y = HEADER_HEIGHT + row * (CELL + GAP);
    if (byte % perRow === 0) {
      parts.push(text(LABEL_WIDTH - 6, y + CELL / 2 + 4, String(byte), PADDING_COLOR, 'end'));
    }
    if (owner === null) {
      parts.push(
        `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="3" fill="url(#pad)"/>`,
      );
      return;
    }
    const dimmed = highlightedMember !== null && owner !== highlightedMember;
    const color = memberColor(owner);
    parts.push(
      `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="3" fill="${color}" fill-opacity="${dimmed ? 0.18 : 0.85}"/>`,
      text(x + CELL / 2, y + CELL / 2 + 4, memberLetter(owner), dimmed ? color : '#ffffff'),
    );
  });
  parts.push('</svg>');
  return parts.join('');
}

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function text(x: number, y: number, content: string, fill: string, anchor = 'middle'): string {
  return `<text x="${x}" y="${y}" fill="${fill}" text-anchor="${anchor}">${content}</text>`;
}
