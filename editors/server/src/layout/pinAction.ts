// "Pin layout with static_assert": asserts the record's size, alignment and
// (where the file already has `offsetof`) each field's offset as they are now,
// right after its definition, so a change that moves them fails to compile.

import type { Range, RecordView } from '@abi-explorer/shared/protocol';
import { formatSizeShort } from '@abi-explorer/shared/format';

export interface PinAction {
  title: string;
  edit: { range: Range; newText: string };
}

/** The action for `record` in a document of `language`, or null where there is nothing to name. */
export function pinAction(
  record: RecordView,
  lines: readonly string[],
  language: 'c' | 'c++',
): PinAction | null {
  const { nameRange, extent } = record;
  // An instantiation is declared by its template, where its arguments are not known.
  if (!nameRange || !extent || record.name.includes('<')) return null;
  const name = lines[nameRange.start.line]!.slice(
    nameRange.start.character,
    nameRange.end.character,
  );
  if (!/^\w+$/.test(name) || record.sizeBits % 8 !== 0) return null;

  const close = lines[extent.end.line] ?? '';
  // Only after a definition that ends its line: `};`, not `} packet;` or `} Packet;`.
  if (!/^\s*};?\s*(\/\/.*)?$/.test(close.slice(Math.max(0, extent.end.character - 1)))) return null;
  const indent = /^\s*/.exec(lines[extent.start.line] ?? '')![0];

  const c = language === 'c';
  const type = c ? `${record.kind === 'union' ? 'union' : 'struct'} ${name}` : name;
  const assert = (condition: string, what: string) =>
    `${indent}${c ? '_Static_assert' : 'static_assert'}(${condition}, "${what}");\n`;
  let text =
    assert(`sizeof(${type}) == ${record.sizeBits / 8}`, `${name}'s size`) +
    assert(
      `${c ? '_Alignof' : 'alignof'}(${type}) == ${record.alignBits / 8}`,
      `${name}'s alignment`,
    );

  const hasOffsetof = lines.some((line) => /^\s*#\s*include\s*<(cstddef|stddef\.h)>/.test(line));
  const plain = record.members.every((member) => member.kind === 'field');
  // Outside the class, offsetof can name only public members.
  const body = lines.slice(extent.start.line, extent.end.line + 1).join('\n');
  const open = record.kind === 'struct' && !/\b(private|protected)\s*:/.test(body);
  if (hasOffsetof && plain && open) {
    for (const member of record.members) {
      if (!/^\w+$/.test(member.label) || member.offsetBits % 8 !== 0) continue;
      text += assert(
        `offsetof(${type}, ${member.label}) == ${member.offsetBits / 8}`,
        `${name}::${member.label}'s offset`,
      );
    }
  }

  // On the line after the definition; at the end of the file, after a line break of its own.
  const after = extent.end.line + 1;
  const at =
    after < lines.length
      ? { line: after, character: 0 }
      : { line: extent.end.line, character: close.length };
  return {
    title: `Pin layout with static_assert (${formatSizeShort(record.sizeBits)}, align ${record.alignBits / 8})`,
    edit: {
      range: { start: at, end: at },
      newText: after < lines.length ? text : `\n${text.replace(/\n$/, '')}`,
    },
  };
}
