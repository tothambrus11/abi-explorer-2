// Hover text: markdown that every client renders, with the byte map as an
// image for clients that asked for one and as monospace text for the rest.

import type { AnalysisContext, RecordView } from '@abi-explorer/shared/protocol';
import {
  baseList,
  byteOwners,
  contextNotes,
  layoutRows,
  memberLetter,
  type LayoutRow,
} from '@abi-explorer/shared/layoutModel';
import { formatOffset, formatSize } from '@abi-explorer/shared/format';
import { svgDataUri, svgMap } from './svgMap.ts';
import { textLayout, textMap } from './textLayout.ts';

export interface HoverOptions {
  images: boolean;
}

export function recordHover(
  record: RecordView,
  context: AnalysisContext,
  options: HoverOptions,
): string {
  const summary = [
    `**${record.kind} ${escape(record.name)}**`,
    formatSize(record.sizeBits),
    `align ${record.alignBits / 8}`,
  ];
  if (record.paddingBytes) summary.push(`${formatSize(record.paddingBytes * 8)} padding`);

  const sections = [summary.join(' · ')];
  const bases = baseList(record);
  if (bases) sections.push(`Bases: ${escape(bases)}`);
  if (options.images) {
    const map = drawMap(record, null, options);
    if (map) sections.push(map);
    if (record.members.length > 0) sections.push(memberTable(record));
  } else {
    // Clients without images often render tables as raw pipes; columns read anywhere.
    sections.push(codeBlock(textLayout(record)));
  }
  sections.push(footnote(context));
  return sections.join('\n\n');
}

export function memberHover(
  record: RecordView,
  memberIndex: number,
  context: AnalysisContext,
  options: HoverOptions,
): string {
  const member = record.members[memberIndex]!;
  const summary = [
    `**${escape(record.name)}::${escape(member.label)}**`,
    `offset ${formatOffset(member.offsetBits)}`,
    formatSize(member.sizeBits),
  ];
  if (member.alignBits > 0) summary.push(`align ${member.alignBits / 8}`);

  const sections = [summary.join(' · ')];
  const before = paddingBefore(record, memberIndex);
  if (before > 0) sections.push(`${formatSize(before * 8)} of padding before it.`);
  const map = drawMap(record, memberIndex, options);
  if (map) sections.push(map);
  sections.push(footnote(context));
  return sections.join('\n\n');
}

function drawMap(
  record: RecordView,
  highlighted: number | null,
  options: HoverOptions,
): string | null {
  if (options.images) {
    const svg = svgMap(record, highlighted);
    return svg && `![${escape(record.name)} layout](${svgDataUri(svg)})`;
  }
  const text = textMap(record, highlighted);
  return text && codeBlock(text);
}

function codeBlock(text: string): string {
  return '```text\n' + text + '\n```';
}

function memberTable(record: RecordView): string {
  const cells = (row: LayoutRow): string[] => {
    if (row.kind === 'padding')
      return ['`·`', '*padding*', formatOffset(row.offsetBits), formatSize(row.sizeBits), ''];
    const member = record.members[row.memberIndex]!;
    return [
      `\`${memberLetter(row.memberIndex)}\``,
      escape(member.label),
      formatOffset(member.offsetBits),
      formatSize(member.sizeBits),
      member.type ? `\`${member.type}\`` : '',
    ];
  };
  return [
    '| | Member | Offset | Size | Type |',
    '|:-:|:--|--:|--:|:--|',
    ...layoutRows(record).map((row) => `| ${cells(row).join(' | ')} |`),
  ].join('\n');
}

/** Whole padding bytes between the previous member's end and this one's start. */
function paddingBefore(record: RecordView, memberIndex: number): number {
  const owners = byteOwners(record);
  let count = 0;
  for (let byte = Math.floor(record.members[memberIndex]!.offsetBits / 8) - 1; byte >= 0; byte--) {
    if (owners[byte] !== null) break;
    count++;
  }
  return count;
}

function footnote(context: AnalysisContext): string {
  return `*${escape(contextNotes(context).join(' · '))}*`;
}

/**
 * Markdown-escapes text such as a name: template arguments and `*` must not
 * turn into markup. Underscores inside words cannot start emphasis, so they are
 * left alone; clients that show markdown as text (Neovim) would show the `\`.
 */
function escape(text: string): string {
  return text.replace(/[\\`*[\]<>|]|(?<!\w)_|_(?!\w)/g, '\\$&');
}
