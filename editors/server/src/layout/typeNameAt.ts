// The type name under the cursor, for hovers on a record's uses: `Packet p;`,
// `sizeof(ns::Shape)`, `std::vector<int> values;`.

import type { Range } from '@abi-explorer/shared/protocol';

export interface TypeNameAt {
  /** As written, qualifiers and template arguments included. */
  spelling: string;
  range: Range;
}

/**
 * The name, with any `a::b::` before it and `<…>` after it, whose identifier
 * contains `character`; null off an identifier.
 */
export function typeNameAt(text: string, line: number, character: number): TypeNameAt | null {
  const word = /\w/;
  let end = character;
  while (end < text.length && word.test(text[end]!)) end++;
  let start = character;
  while (start > 0 && word.test(text[start - 1]!)) start--;
  if (start === end || /^\d/.test(text[start]!)) return null;
  while (start >= 2 && text.slice(start - 2, start) === '::') {
    let qualifier = start - 2;
    while (qualifier > 0 && word.test(text[qualifier - 1]!)) qualifier--;
    if (qualifier === start - 2) break;
    start = qualifier;
  }

  let argumentsEnd = end;
  while (argumentsEnd < text.length && text[argumentsEnd] === ' ') argumentsEnd++;
  if (text[argumentsEnd] === '<') {
    let depth = 0;
    for (let index = argumentsEnd; index < text.length; index++) {
      const char = text[index]!;
      if (char === '<' || char === '(') depth++;
      else if (char === '>' || char === ')') depth--;
      else if (char === ';' || char === '{') break;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  return {
    spelling: text.slice(start, end),
    range: { start: { line, character: start }, end: { line, character: end } },
  };
}
