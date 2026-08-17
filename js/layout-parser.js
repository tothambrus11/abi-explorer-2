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

const BASE_SUFFIXES = [
  { re: /\s*\(primary base\)$/, kind: 'primary-base' },
  { re: /\s*\(primary virtual base\)$/, kind: 'primary-vbase' },
  { re: /\s*\(virtual base\)$/, kind: 'vbase' },
  { re: /\s*\(base\)$/, kind: 'base' },
];

const RECORD_KEYWORDS = ['struct', 'union', 'class', '__interface', 'interface'];

/** Parse one "offset | content" line. Returns null for non-row lines. */
function parseRowLine(line) {
  const m = /^(\s*)([0-9]+(?::(?:[0-9]+-[0-9]+|-))?)?\s*\|(.*)$/.exec(line);
  if (!m) return null;
  const [, , off, rest] = m;
  return { off: off ?? null, rest };
}

function parseOffset(off) {
  // returns { offsetBits, bitWidth|null, isBitfield, isZeroWidth }
  if (off === null) return null;
  const bf = /^([0-9]+):([0-9]+)-([0-9]+)$/.exec(off);
  if (bf) {
    const byte = Number(bf[1]), first = Number(bf[2]), last = Number(bf[3]);
    return { offsetBits: byte * 8 + first, bitWidth: last - first + 1, isBitfield: true, isZeroWidth: false };
  }
  const zw = /^([0-9]+):-$/.exec(off);
  if (zw) {
    return { offsetBits: Number(zw[1]) * 8, bitWidth: 0, isBitfield: true, isZeroWidth: true };
  }
  return { offsetBits: Number(off) * 8, bitWidth: null, isBitfield: false, isZeroWidth: false };
}

/**
 * Parse the full dump text into an array of record objects:
 * {
 *   kind, name, isEmpty, sizeBytes, align, dsize?, nvsize?, nvalign?, ...extras,
 *   rows: [ { rowKind: 'field'|'base'|'vbase'|'primary-base'|'special',
 *             offsetBits, bitWidth?, isBitfield, isZeroWidth,
 *             type, name, label, depth, children: [...] } ]
 * }
 */
export function parseRecordLayouts(text) {
  const records = [];
  const blocks = text.split(/\*\*\* Dumping AST Record Layout\s*\n/).slice(1);

  for (const block of blocks) {
    const lines = block.split('\n');
    let record = null;
    const stack = []; // parallel to depth: stack[d] = row whose children are at depth d+1
    let trailer = '';

    for (const line of lines) {
      const row = parseRowLine(line);
      if (!row) {
        if (record && trailer) break; // block ended
        continue;
      }
      const content = row.rest.replace(/\s+$/, '');
      if (row.off === null) {
        // trailer line(s): "[sizeof=..., align=...," / " nvsize=..., nvalign=...]"
        trailer += ' ' + content;
        continue;
      }

      const indent = /^ */.exec(row.rest)[0].length;
      const depth = Math.max(0, Math.round((indent - 1) / 2)); // header " struct X" => depth 0
      const offset = parseOffset(row.off);
      const trimmed = content.trim();
      const trailingSpace = /\s$/.test(row.rest.replace(/\n$/, '')) && trimmed.length > 0;

      if (record === null) {
        // Header row: "struct Foo" (+ optional "(empty)")
        let name = trimmed;
        let isEmpty = false;
        if (/\s*\(empty\)$/.test(name)) { isEmpty = true; name = name.replace(/\s*\(empty\)$/, ''); }
        const kw = RECORD_KEYWORDS.find(k => name === k || name.startsWith(k + ' '));
        record = {
          kind: kw || 'struct',
          name: kw ? name.slice(kw.length).trim() : name,
          isEmpty,
          rows: [],
        };
        stack.length = 0;
        stack[0] = record;
        continue;
      }

      // Child row at depth >= 1
      let entry = null;
      let body = trimmed;
      let isEmpty = false;
      if (/\s*\(empty\)$/.test(body)) { isEmpty = true; body = body.replace(/\s*\(empty\)$/, ''); }

      // Special rows are fully parenthesized: "(Base vtable pointer)", "(vtordisp for vbase X)"...
      if (/^\(.*\)$/.test(body)) {
        entry = {
          rowKind: 'special', label: body.slice(1, -1),
          type: null, name: null,
          ...offset, isEmpty, children: [],
        };
      } else {
        // Base subobject rows end in a known suffix
        let baseKind = null;
        for (const s of BASE_SUFFIXES) {
          if (s.re.test(body)) { baseKind = s.kind; body = body.replace(s.re, ''); break; }
        }
        if (baseKind) {
          entry = {
            rowKind: baseKind, type: body, name: null, label: null,
            ...offset, isEmpty, children: [],
          };
        } else {
          // Field row: "<type> <name>", name may be empty (unnamed bit-field,
          // anonymous struct/union member). Clang always emits a space before
          // the (possibly empty) name, so an original trailing space means
          // the name is empty.
          let type, name;
          if (!trailingSpace && / /.test(body)) {
            const i = body.lastIndexOf(' ');
            type = body.slice(0, i);
            name = body.slice(i + 1);
          } else {
            type = body.trim();
            name = '';
          }
          entry = {
            rowKind: 'field', type, name, label: null,
            ...offset, isEmpty, children: [],
          };
        }
      }

      entry.depth = depth;
      const parent = stack[depth - 1];
      (parent === record ? record.rows : parent.children).push(entry);
      stack[depth] = entry;
      stack.length = depth + 1;
    }

    if (!record) continue;

    // Trailer: "[sizeof=32, dsize=26, align=8, nvsize=26, nvalign=8]"
    for (const kv of trailer.matchAll(/([A-Za-z_]+)=([0-9]+)/g)) {
      const key = kv[1], val = Number(kv[2]);
      if (key === 'sizeof') record.sizeBytes = val;
      else record[key] = val;
    }
    if (record.sizeBytes === undefined) continue; // malformed block
    records.push(record);
  }
  return records;
}

/** Flatten a record's row tree into a list with depth info (pre-order). */
export function flattenRows(record) {
  const out = [];
  const visit = (rows) => {
    for (const r of rows) {
      out.push(r);
      if (r.children.length) visit(r.children);
    }
  };
  visit(record.rows);
  return out;
}

const INTERNAL_RECORDS = new Set([
  '__va_list_tag', '__NSConstantString_tag', '__block_descriptor',
  '__block_literal_generic',
]);

/** True for compiler-internal records that users didn't declare. */
export function isInternalRecord(rec) {
  return INTERNAL_RECORDS.has(rec.name) || rec.name.startsWith('__abix_');
}

/** True for anonymous records (they also appear inline in their parent). */
export function isAnonymousRecord(rec) {
  return /\((?:unnamed|anonymous|lambda) at /.test(rec.name);
}
