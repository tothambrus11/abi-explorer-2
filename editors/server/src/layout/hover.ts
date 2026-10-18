// Hover text: markdown that every client renders, with the byte map as an
// image for clients that asked for one and as monospace text for the rest.

import type { AnalysisContext, RecordView } from '@abi-explorer/shared/protocol';
import {
  baseList,
  byteOwners,
  contextNotes,
  recordSummary,
  reorderNote,
} from '@abi-explorer/shared/layoutModel';
import { formatOffset, formatSizeShort } from '@abi-explorer/shared/format';
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
  // The same summary as the inlay hint and the panel's heading.
  const sections = [`**${record.kind} ${escape(record.name)}** · ${recordSummary(record)}`];
  const bases = baseList(record);
  if (bases) sections.push(`Bases: ${escape(bases)}`);
  const reorder = reorderNote(record);
  if (reorder) sections.push(reorder);
  // Clients without images often render tables as raw pipes; columns read anywhere.
  // A record too large to map has no image, and its members still need a table.
  const svg = options.images ? svgMap(record, { table: true }) : null;
  sections.push(svg ? image(record, svg) : codeBlock(textLayout(record)));
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
  const title = `**${escape(record.name)}::${escape(member.label)}**${member.type ? ` \`${member.type}\`` : ''}`;
  const summary = [
    title,
    `offset ${formatOffset(member.offsetBits)}`,
    formatSizeShort(member.sizeBits),
  ];
  if (member.alignBits > 0) summary.push(`align ${member.alignBits / 8}`);

  const sections = [summary.join(' · '), memberPlacement(record, memberIndex)];
  if (options.images) {
    const svg = svgMap(record, { highlightedMember: memberIndex });
    if (svg) sections.push(image(record, svg));
  } else {
    const text = textMap(record, memberIndex);
    if (text) sections.push(codeBlock(text));
  }
  sections.push(footnote(context));
  return sections.join('\n\n');
}

function image(record: RecordView, svg: string): string {
  return `![${escape(record.name)} layout](${svgDataUri(svg)})`;
}

function codeBlock(text: string): string {
  return '```text\n' + text + '\n```';
}

/** `Bytes 4–7, after 3 B of padding.`: where the member sits, and the padding around it. */
function memberPlacement(record: RecordView, memberIndex: number): string {
  const member = record.members[memberIndex]!;
  const first = Math.floor(member.offsetBits / 8);
  const last = Math.max(first, Math.ceil((member.offsetBits + member.sizeBits) / 8) - 1);
  const owners = byteOwners(record);
  const paddingRun = (from: number, step: number) => {
    let count = 0;
    for (
      let byte = from;
      byte >= 0 && byte < owners.length && owners[byte] === null;
      byte += step
    ) {
      count++;
    }
    return count;
  };
  const before = paddingRun(first - 1, -1);
  const after = paddingRun(last + 1, 1);
  const where = first === last ? `Byte ${first}` : `Bytes ${first}–${last}`;
  const padding = [
    before > 0 ? `after ${formatSizeShort(before * 8)} of padding` : null,
    after > 0 ? `followed by ${formatSizeShort(after * 8)} of padding` : null,
  ].filter(Boolean);
  return `${where}${padding.length > 0 ? ', ' + padding.join(', ') : ''}.`;
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
