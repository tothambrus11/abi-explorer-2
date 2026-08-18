// Parser for clang's `-fdump-record-layouts[-complete]` textual output.
//
// The dump consists of blocks like:
//
//   *** Dumping AST Record Layout
//            0 | struct Derived
//            0 |   struct Base (primary base)
//            0 |     (Base vtable pointer)
//            8 |     int x
//        9:0-2 |   unsigned int bits
//           12 |   char z
//              | [sizeof=16, dsize=13, align=8,
//              |  nvsize=13, nvalign=8]
//
// Offsets are bytes, or `byte:firstbit-lastbit` for bit-fields, or `byte:-`
// for zero-width bit-fields. Nesting depth is 2 spaces per level.

import type { LayoutRow, RecordKind, RecordLayout, RowKind } from './types';

const BASE_SUFFIXES: { re: RegExp; kind: RowKind }[] = [
  { re: /\s*\(primary base\)$/, kind: 'primary-base' },
  { re: /\s*\(primary virtual base\)$/, kind: 'primary-vbase' },
  { re: /\s*\(virtual base\)$/, kind: 'vbase' },
  { re: /\s*\(base\)$/, kind: 'base' },
];

const RECORD_KEYWORDS: RecordKind[] = ['struct', 'union', 'class', '__interface', 'interface'];

interface OffsetInfo {
  offsetBits: number;
  bitWidth: number | null;
  isBitfield: boolean;
  isZeroWidth: boolean;
}

function parseOffset(off: string): OffsetInfo {
  const bf = /^([0-9]+):([0-9]+)-([0-9]+)$/.exec(off);
  if (bf) {
    const byte = Number(bf[1]);
    const first = Number(bf[2]);
    const last = Number(bf[3]);
    return {
      offsetBits: byte * 8 + first,
      bitWidth: last - first + 1,
      isBitfield: true,
      isZeroWidth: false,
    };
  }
  const zw = /^([0-9]+):-$/.exec(off);
  if (zw) {
    return { offsetBits: Number(zw[1]) * 8, bitWidth: 0, isBitfield: true, isZeroWidth: true };
  }
  return { offsetBits: Number(off) * 8, bitWidth: null, isBitfield: false, isZeroWidth: false };
}

const ROW_RE = /^(\s*)([0-9]+(?::(?:[0-9]+-[0-9]+|-))?)?\s*\|(.*)$/;

/** Parse the full dump text into records. Malformed blocks are skipped. */
export function parseRecordLayouts(text: string): RecordLayout[] {
  const records: RecordLayout[] = [];
  const blocks = text.split(/\*\*\* Dumping AST Record Layout\s*\n/).slice(1);

  const seen = new Map<string, number>();
  for (const block of blocks) {
    const record = parseBlock(block);
    if (!record) continue;
    // Function-local records can repeat a name; number duplicates so keys stay unique.
    const k = record.kind + ' ' + record.name;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    if (n > 0) record.dup = n;
    records.push(record);
  }
  return records;
}

function parseBlock(block: string): RecordLayout | null {
  let record:
    (Omit<RecordLayout, 'sizeBytes' | 'align'> & { sizeBytes?: number; align?: number }) | null =
    null;
  const stack: (LayoutRow | 'root')[] = [];
  let trailer = '';

  for (const line of block.split('\n')) {
    const m = ROW_RE.exec(line);
    if (!m) {
      if (record && trailer) break;
      continue;
    }
    const off = m[2];
    const rest = m[3] ?? '';
    const content = rest.replace(/\s+$/, '');
    if (off === undefined) {
      trailer += ' ' + content;
      continue;
    }

    const indent = (/^ */.exec(rest) ?? [''])[0].length;
    const depth = Math.max(0, Math.round((indent - 1) / 2));
    const offset = parseOffset(off);
    const trimmed = content.trim();
    // Clang always prints a space before the (possibly empty) field name; an
    // original trailing space therefore means "unnamed".
    const trailingSpace = /\s$/.test(rest) && trimmed.length > 0;

    if (record === null) {
      let name = trimmed;
      let isEmpty = false;
      if (/\s*\(empty\)$/.test(name)) {
        isEmpty = true;
        name = name.replace(/\s*\(empty\)$/, '');
      }
      const kw = RECORD_KEYWORDS.find((k) => name === k || name.startsWith(k + ' '));
      record = {
        kind: kw ?? 'struct',
        name: kw ? name.slice(kw.length).trim() : name,
        isEmpty,
        rows: [],
      };
      stack.length = 0;
      stack[0] = 'root';
      continue;
    }

    let body = trimmed;
    let isEmpty = false;
    if (/\s*\(empty\)$/.test(body)) {
      isEmpty = true;
      body = body.replace(/\s*\(empty\)$/, '');
    }

    let entry: LayoutRow;
    if (/^\(.*\)$/.test(body)) {
      entry = {
        rowKind: 'special',
        label: body.slice(1, -1),
        type: null,
        name: null,
        ...offset,
        isEmpty,
        depth,
        children: [],
      };
    } else {
      let baseKind: RowKind | null = null;
      for (const s of BASE_SUFFIXES) {
        if (s.re.test(body)) {
          baseKind = s.kind;
          body = body.replace(s.re, '');
          break;
        }
      }
      if (baseKind) {
        entry = {
          rowKind: baseKind,
          type: body,
          name: null,
          label: null,
          ...offset,
          isEmpty,
          depth,
          children: [],
        };
      } else {
        let type: string;
        let name: string;
        if (!trailingSpace && body.includes(' ')) {
          const i = body.lastIndexOf(' ');
          type = body.slice(0, i);
          name = body.slice(i + 1);
        } else {
          type = body.trim();
          name = '';
        }
        entry = {
          rowKind: 'field',
          type,
          name,
          label: null,
          ...offset,
          isEmpty,
          depth,
          children: [],
        };
      }
    }

    const parent = stack[depth - 1];
    if (parent === undefined) continue; // malformed indentation
    (parent === 'root' ? record.rows : parent.children).push(entry);
    stack[depth] = entry;
    stack.length = depth + 1;
  }

  if (!record) return null;
  for (const kv of trailer.matchAll(/([A-Za-z_]+)=([0-9]+)/g)) {
    const key = kv[1]!;
    const val = Number(kv[2]);
    if (key === 'sizeof') record.sizeBytes = val;
    else if (
      key === 'align' ||
      key === 'dsize' ||
      key === 'nvsize' ||
      key === 'nvalign' ||
      key === 'preferredalign'
    ) {
      record[key] = val;
    }
  }
  if (record.sizeBytes === undefined || record.align === undefined) return null;
  return record as RecordLayout;
}

/** Flatten a record's row tree (pre-order). */
export function flattenRows(record: RecordLayout): LayoutRow[] {
  const out: LayoutRow[] = [];
  const visit = (rows: LayoutRow[]) => {
    for (const r of rows) {
      out.push(r);
      if (r.children.length) visit(r.children);
    }
  };
  visit(record.rows);
  return out;
}

const INTERNAL_RECORDS = new Set([
  '__va_list_tag',
  '__NSConstantString_tag',
  '__block_descriptor',
  '__block_literal_generic',
]);

/** True for compiler-internal records and our own probe structs. */
export function isInternalRecord(rec: RecordLayout): boolean {
  return INTERNAL_RECORDS.has(rec.name) || rec.name.startsWith('__abix_');
}

/**
 * For an anonymous record declared in `fileName`, the "at file:line:col)" tail
 * of its name — a substring only that record's qualified name contains, usable
 * as an `-ast-dump-filter`. Null for named or nested-anonymous records.
 */
export function anonymousLocationFilter(rec: RecordLayout, fileName: string): string | null {
  const m = new RegExp(
    `^\\((?:unnamed|anonymous)[^()]* at (${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+:\\d+)\\)$`,
  ).exec(rec.name);
  return m ? `at ${m[1]!})` : null;
}

/** True for anonymous records (they also appear inline in their parent). */
export function isAnonymousRecord(rec: RecordLayout): boolean {
  return /\((?:unnamed|anonymous|lambda) at /.test(rec.name);
}

/** Stable identity for a record within one analysis. */
export function recordKey(rec: RecordLayout): string {
  return rec.kind + ' ' + rec.name + (rec.dup ? `#${rec.dup}` : '');
}
