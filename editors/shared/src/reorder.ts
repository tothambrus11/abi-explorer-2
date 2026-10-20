// The reorder warning and its two fixes, as text edits: what the language
// server offers every editor and what the web explorer's editor offers too.
//
// "Reorder members by alignment" moves whole lines, so it is offered only
// where each member is one declaration on a line of its own and only comments
// and blank lines are between them (not an access specifier, a preprocessor
// line, a nested type). A member takes the comment lines right above it along;
// everything else in the record (other comments, functions, blank lines) stays
// put. A record whose order is kept on purpose (a wire format, a layout shared
// with C) says so in a comment above it, `// abi-explorer: keep order`, which
// the other fix writes.

import type { Range } from './protocol.ts';
import { formatSizeShort } from './format.ts';
import { reorderWarning, tighterOrder, type ReorderRecord } from './layoutModel.ts';

const KEEP_ORDER = /abi-explorer:\s*keep[- ]order/i;
const KEEP_ORDER_COMMENT = '// abi-explorer: keep order';

/** The warning on the record's name, or null: its order costs nothing, or is kept on purpose. */
export function reorderWarningAt(record: ReorderRecord, lines: readonly string[]): string | null {
  if (!record.nameRange || keepsOrder(record, lines)) return null;
  return reorderWarning(record);
}

/** Whether the comments right above the record (or its first line) ask to keep its order. */
export function keepsOrder(record: ReorderRecord, lines: readonly string[]): boolean {
  if (!record.extent) return false;
  const start = record.extent.start.line;
  if (KEEP_ORDER.test(lines[start] ?? '')) return true;
  for (let line = start - 1; line >= 0; line--) {
    const text = lines[line]!.trim();
    if (KEEP_ORDER.test(text)) return true;
    if (!isCommentOrTemplateHead(text)) return false;
  }
  return false;
}

/** The warning's other fix: the comment that keeps the order, above the declaration. */
export function keepOrderEdit(
  record: ReorderRecord,
  lines: readonly string[],
): { range: Range; newText: string } | null {
  if (!record.extent || keepsOrder(record, lines)) return null;
  let line = record.extent.start.line;
  // Above `template <…>` when that is a line of its own.
  while (line > 0 && /^template\s*</.test(lines[line - 1]!.trim())) line--;
  const indent = /^\s*/.exec(lines[line] ?? '')![0];
  const at = { line, character: 0 };
  return { range: { start: at, end: at }, newText: `${indent}${KEEP_ORDER_COMMENT}\n` };
}

function isCommentOrTemplateHead(text: string): boolean {
  return /^(\/\/|\/\*|\*)/.test(text) || /^template\s*</.test(text);
}

export interface ReorderAction {
  title: string;
  edits: { range: Range; newText: string }[];
}

/** The action for `record`, given the document's lines, or null where it would not be safe. */
export function reorderAction(
  record: ReorderRecord,
  lines: readonly string[],
): ReorderAction | null {
  const tighter = tighterOrder(record);
  if (!tighter) return null;
  const memberLines = record.members.map((member) => member.nameRange?.start.line);
  if (memberLines.some((line) => line === undefined)) return null;
  const slots = (memberLines as number[]).slice().sort((a, b) => a - b);
  if (new Set(slots).size !== slots.length) return null;

  // Each member moves with the comment lines right above it.
  const blocks = new Map<number, { start: number; end: number }>();
  let previousEnd = -1;
  const labels = record.members.map((member) => member.label);
  if (record.extent && memberInitializerUsesAnother(record.extent, lines, labels)) return null;
  for (const line of slots) {
    const code = withoutComment(lines[line] ?? '');
    if (
      !code.endsWith(';') ||
      initializerUsesAnother(code, labels) ||
      hasTopLevelComma(code) ||
      /\b(struct|class|union|enum)\b[^;]*\{/.test(code)
    ) {
      return null;
    }
    let start = line;
    while (start - 1 > previousEnd && isComment(lines[start - 1] ?? '')) start--;
    // The block holds the whole declaration: the line before it ends another.
    const before = withoutComment(lines[start - 1] ?? '');
    if (!(before === '' || /[;{}]$/.test(before) || ACCESS.test(before))) return null;
    blocks.set(start, { start, end: line });
    previousEnd = line;
  }
  const first = Math.min(...blocks.keys());
  const last = slots.at(-1)!;
  // Between the members, nothing but comments and blank lines: a member moved
  // above a type or constant it uses would no longer compile, and one moved
  // into or out of an anonymous struct would change the layout.
  const inBlock = (line: number) =>
    [...blocks.values()].some((block) => line >= block.start && line <= block.end);
  for (let line = first; line <= last; line++) {
    if (!inBlock(line) && withoutComment(lines[line] ?? '') !== '' && !isComment(lines[line]!)) {
      return null;
    }
  }

  // The same lines, the blocks taking each other's places in the tighter order.
  const byMember = memberLines.map((line) => [...blocks.values()].find((b) => b.end === line)!);
  const moved: string[] = [];
  let slot = 0;
  for (let line = first; line <= last; line++) {
    const block = blocks.get(line);
    if (!block) {
      moved.push(lines[line]!);
      continue;
    }
    const incoming = byMember[tighter.order[slot++]!]!;
    moved.push(...lines.slice(incoming.start, incoming.end + 1));
    line = block.end;
  }
  const edits = moved.flatMap((text, index) => {
    const line = first + index;
    return text === lines[line]
      ? []
      : [
          {
            range: { start: { line, character: 0 }, end: { line, character: lines[line]!.length } },
            newText: text,
          },
        ];
  });
  return {
    title: `Reorder members by alignment (${formatSizeShort(record.sizeBits)} → ${formatSizeShort(tighter.sizeBits)})`,
    edits,
  };
}

/** A line holding only a comment, or part of a block comment. */
function isComment(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

const ACCESS = /^(public|private|protected)\s*:$/;

/** The line's code, trimmed, without a trailing line comment, or empty for a whole-line block comment. */
function withoutComment(line: string): string {
  const code = line.replace(/\/\/.*$/, '').trim();
  return /^\/\*.*\*\/$/.test(code) ? '' : code;
}

/**
 * `double area = width * height;`: members are initialised in declaration order,
 * so moving one could read another before it is set.
 */
function initializerUsesAnother(code: string, labels: readonly string[]): boolean {
  const initializer = /(=|\{)(.*)$/.exec(code.replace(/<[^<>]*>/g, ''))?.[2];
  return (
    initializer !== undefined &&
    labels.some((label) => /^\w+$/.test(label) && new RegExp(`\\b${label}\\b`).test(initializer))
  );
}

/** `S() : a(1), d(a * 2.0) {}` in the record: the same, through a constructor. */
function memberInitializerUsesAnother(
  extent: Range,
  lines: readonly string[],
  labels: readonly string[],
): boolean {
  const body = lines.slice(extent.start.line, extent.end.line + 1).join('\n');
  const names = new Set(labels.filter((label) => /^\w+$/.test(label)));
  for (const [, name, argument] of body.matchAll(/\b(\w+)\s*[({]([^(){}]*)[)}]/g)) {
    if (!names.has(name!)) continue;
    const words = argument!.match(/\b\w+\b/g) ?? [];
    if (words.some((word) => word !== name && names.has(word))) return true;
  }
  return false;
}

/** `int x, y;` declares two members; `std::map<int, int> m;` declares one. */
function hasTopLevelComma(code: string): boolean {
  let depth = 0;
  for (const char of code) {
    if ('<([{'.includes(char)) depth++;
    else if ('>)]}'.includes(char)) depth--;
    else if (char === ',' && depth === 0) return true;
  }
  return false;
}
