// The reorder warning and its two fixes, as text edits: what the language
// server offers every editor and what the web explorer's editor offers too.
//
// "Reorder members by alignment" moves lines, so it is offered only where
// each member is declared on one line and only comments and blank lines are
// between them (not an access specifier, a preprocessor line, a nested type).
// A line declaring several members is split into one line per member first. A
// member takes the comment lines right above it along; everything else in the
// record (other comments, functions, blank lines) stays put. A record whose order is kept on purpose (a wire format, a layout shared
// with C) says so in a comment above it, `// abi-explorer: keep order`, which
// the other fix writes.

import type { Position, Range } from './protocol.ts';
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
  const starts = record.members.map((member) => member.nameRange?.start);
  if (starts.some((start) => start === undefined)) return null;
  const at = starts as Position[];
  const labels = record.members.map((member) => member.label);
  if (record.extent && memberInitializerUsesAnother(record.extent, lines, labels)) return null;

  // What each member line becomes. A line declaring one member moves whole,
  // with the comment lines right above it. A line declaring several (`int x,
  // y;`, `char a; double b;`) is split into a line per member, and its
  // trailing comment, which is about all of them, stays where the line was.
  const units = new Map<number, Unit>();
  const textOf = new Map<number, string[]>();
  const memberLines = [...new Set(at.map((position) => position.line))].sort((a, b) => a - b);
  let previousEnd = -1;
  for (const line of memberLines) {
    const text = lines[line] ?? '';
    const here = at
      .map((position, member) => ({ member, character: position.character }))
      .filter((_, member) => at[member]!.line === line)
      .sort((a, b) => a.character - b.character);
    const comment = /\/\/.*$/.exec(text);
    const code = comment ? text.slice(0, comment.index) : text;
    if (!code.trim().endsWith(';') || /\b(struct|class|union|enum)\b[^;]*\{/.test(code)) {
      return null;
    }
    const declarations = declarationsOf(
      code,
      here.map((h) => h.character),
    );
    if (!declarations || declarations.some((d) => initializerUsesAnother(d, labels))) return null;
    let start = line;
    if (here.length === 1) {
      while (start - 1 > previousEnd && isComment(lines[start - 1] ?? '')) start--;
      textOf.set(here[0]!.member, lines.slice(start, line + 1));
    } else {
      const indent = /^\s*/.exec(text)![0];
      here.forEach((h, index) => textOf.set(h.member, [indent + declarations[index]!]));
    }
    // The unit holds the whole declaration: the line before it ends another.
    const before = withoutComment(lines[start - 1] ?? '');
    if (!(before === '' || /[;{}]$/.test(before) || ACCESS.test(before))) return null;
    units.set(start, {
      end: line,
      slots: here.length,
      kept: here.length > 1 && comment ? `${/^\s*/.exec(text)![0]}${comment[0]}` : null,
    });
    previousEnd = line;
  }
  const first = Math.min(...units.keys());
  const last = memberLines.at(-1)!;
  // Between the members, nothing but comments and blank lines: a member moved
  // above a type or constant it uses would no longer compile, and one moved
  // into or out of an anonymous struct would change the layout.
  const inUnit = (line: number) =>
    [...units].some(([start, unit]) => line >= start && line <= unit.end);
  for (let line = first; line <= last; line++) {
    if (!inUnit(line) && withoutComment(lines[line] ?? '') !== '' && !isComment(lines[line]!)) {
      return null;
    }
  }

  // The same lines, the members taking each other's places in the tighter order.
  const moved: string[] = [];
  let slot = 0;
  for (let line = first; line <= last; line++) {
    const unit = units.get(line);
    if (!unit) {
      moved.push(lines[line]!);
      continue;
    }
    if (unit.kept !== null) moved.push(unit.kept);
    for (let i = 0; i < unit.slots; i++) moved.push(...textOf.get(tighter.order[slot++]!)!);
    line = unit.end;
  }
  const title = `Reorder members by alignment (${formatSizeShort(record.sizeBits)} → ${formatSizeShort(tighter.sizeBits)})`;
  const wholeLine = (line: number) => ({
    start: { line, character: 0 },
    end: { line, character: lines[line]!.length },
  });
  if (moved.length !== last - first + 1) {
    // Lines were split: one edit over the members' lines.
    return {
      title,
      edits: [
        {
          range: { start: wholeLine(first).start, end: wholeLine(last).end },
          newText: moved.join('\n'),
        },
      ],
    };
  }
  const edits = moved.flatMap((text, index) => {
    const line = first + index;
    return text === lines[line] ? [] : [{ range: wholeLine(line), newText: text }];
  });
  return { title, edits };
}

/** A run of lines that moves as one: a member line (with its comments), or a split line. */
interface Unit {
  /** Its last line. */
  end: number;
  /** How many members it declares, so how many places it leaves to fill. */
  slots: number;
  /** A split line's trailing comment, which stays in its place. */
  kept: string | null;
}

/**
 * Each member's own declaration, given the line's code and where the
 * members' names start on it: `int x, *y;` gives `int x;` and `int *y;`.
 * Null when the line holds something else too (a static member, a function),
 * or a declarator whose type is not a plain prefix (`int (*f)(int), x;`).
 */
function declarationsOf(code: string, names: readonly number[]): string[] | null {
  // Statements, and in each the declarators, split at top-level `;` and `,`.
  const statements: { start: number; end: number }[][] = [];
  let parts: { start: number; end: number }[] = [];
  let partStart = 0;
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const char = code[i]!;
    if ('<([{'.includes(char)) depth++;
    else if ('>)]}'.includes(char)) depth--;
    else if (depth === 0 && (char === ',' || char === ';')) {
      parts.push({ start: partStart, end: i });
      partStart = i + 1;
      if (char === ';') {
        statements.push(parts);
        parts = [];
      }
    }
  }
  if (parts.length > 0 || code.slice(partStart).trim() !== '') return null;
  const out: string[] = [];
  let name = 0;
  for (const statement of statements) {
    for (const part of statement) {
      const inside = names.filter((n) => n >= part.start && n < part.end);
      if (inside.length !== 1 || names[name] !== inside[0]) return null;
      name++;
    }
    if (statement.length === 1) {
      const only = statement[0]!;
      out.push(`${code.slice(only.start, only.end).trim()};`);
      continue;
    }
    // `const char *a, *b;`: the type is what comes before the first
    // declarator's name, less the `*` and `&` that belong to that declarator.
    const head = statement[0]!;
    const before = code.slice(head.start, names[name - statement.length]);
    const type = before.replace(/[\s*&]*$/, '');
    if (type.trim() === '' || /[(,]\s*$/.test(type)) return null;
    statement.forEach((part, index) => {
      const from = index === 0 ? head.start + type.length : part.start;
      out.push(`${type.trim()} ${code.slice(from, part.end).trim()};`);
    });
  }
  return name === names.length ? out : null;
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
