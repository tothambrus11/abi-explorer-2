// Builds the render model for one record: a flat list of leaf extents
// (fields, vtable pointers), padding runs, and summary stats.

import { resolveTypeSize } from './size-resolver.js';

/**
 * @param record    parsed record (from layout-parser)
 * @param scalars   scalar size table (Map)
 * @param recordIndex Map name -> record
 * @param probeSizes Map spelling -> bits (from pass 2), may be empty
 * @returns {
 *   record, leaves: [...], markers: [...], paddings: [...],
 *   sizeBits, paddingBytes, unresolved: [spelling...]
 * }
 */
export function buildRenderModel(record, scalars, recordIndex, probeSizes) {
  const leaves = [];
  const markers = [];
  const groups = []; // record-typed members / bases with inline children
  const unresolved = new Set();
  const sizeBits = record.sizeBytes * 8;

  const ptrBits = scalars.get('ptr') ? scalars.get('ptr').size * 8 : null;

  const visit = (rows, path, parentEnd, inUnion, owner) => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const label = row.rowKind === 'field' ? (row.name || '(anonymous)') : null;
      const pathName = label ? [...path, label] : path;

      if (row.rowKind === 'special') {
        // vtable/vftable/vbtable pointer (or vtordisp etc.) — pointer sized
        leaves.push({
          kind: 'special', row, path,
          name: row.label, type: null,
          offsetBits: row.offsetBits,
          sizeBits: ptrBits ?? 0, align: scalars.get('ptr')?.align ?? null,
          estimated: ptrBits === null,
          depth: path.length, owner,
        });
        continue;
      }

      const isBase = row.rowKind !== 'field';
      if (isBase) {
        if (row.isEmpty) {
          markers.push({ kind: 'empty-base', row, path, name: row.type, offsetBits: row.offsetBits });
        }
        {
          const first = leaves.length;
          visit(row.children, [...path, baseLabel(row)], parentEnd, inUnion, stripKw(row.type));
          const r = resolveWithProbes(row.type, scalars, recordIndex, probeSizes);
          groups.push({ kind: row.rowKind, name: baseLabel(row), type: row.type, owner, path,
            offsetBits: row.offsetBits, sizeBits: r.bits ?? null, align: r.align ?? null,
            leafIndexes: range(first, leaves.length), isBase: true });
        }
        continue;
      }

      // Field row
      if (row.isBitfield) {
        if (row.isZeroWidth) {
          markers.push({ kind: 'zero-bitfield', row, path, name: row.name || ':0', offsetBits: row.offsetBits, type: row.type });
        } else {
          leaves.push({
            kind: 'bitfield', row, path,
            name: row.name || '(pad bits)', type: row.type,
            offsetBits: row.offsetBits, sizeBits: row.bitWidth, align: null,
            estimated: false, depth: path.length, owner,
          });
        }
        continue;
      }

      if (row.children.length > 0) {
        // Record-typed member with inline children: recurse; the member's own
        // extent is implied by its children plus its record's size for padding.
        {
          const first = leaves.length;
          visit(row.children, pathName, endOf(row, scalars, recordIndex, probeSizes, parentEnd), inUnion || isUnionType(row.type, recordIndex), stripKw(row.type));
          const r = resolveWithProbes(row.type, scalars, recordIndex, probeSizes);
          groups.push({ kind: 'member', name: row.name || '(anonymous)', type: row.type, owner, path,
            offsetBits: row.offsetBits, sizeBits: r.bits ?? null, align: r.align ?? null,
            leafIndexes: range(first, leaves.length), isBase: false });
        }
        continue;
      }

      const res = resolveWithProbes(row.type, scalars, recordIndex, probeSizes);
      let bits = res.bits, estimated = false;
      const align = res.align ?? null;
      if (bits === undefined) {
        if (res.probe) unresolved.add(res.probe);
        // Estimate: to next sibling's offset, or to parent end.
        bits = estimateBits(rows, i, row, parentEnd, inUnion);
        estimated = true;
      }
      leaves.push({
        kind: 'field', row, path,
        name: row.name || '(anonymous)', type: row.type,
        offsetBits: row.offsetBits, sizeBits: bits, align,
        estimated, depth: path.length, owner,
      });
    }
  };

  visit(record.rows, [], sizeBits, record.kind === 'union', record.name);

  // Compute padding: bytes of the record not covered by any leaf.
  const covered = new Array(record.sizeBytes).fill(false);
  for (const leaf of leaves) {
    const from = Math.floor(leaf.offsetBits / 8);
    const to = Math.min(record.sizeBytes, Math.ceil((leaf.offsetBits + leaf.sizeBits) / 8));
    for (let b = from; b < to; b++) covered[b] = true;
  }
  const paddings = [];
  let run = null;
  for (let b = 0; b < record.sizeBytes; b++) {
    if (!covered[b]) {
      if (run && run.end === b) run.end = b + 1;
      else paddings.push(run = { start: b, end: b + 1 });
    }
  }
  const paddingBytes = paddings.reduce((n, p) => n + (p.end - p.start), 0);

  return { record, leaves, groups, markers, paddings, sizeBits, paddingBytes, unresolved: [...unresolved] };
}

function range(a, b) {
  const out = [];
  for (let i = a; i < b; i++) out.push(i);
  return out;
}

function stripKw(type) {
  return (type || '').replace(/^(?:struct|class|union|__interface)\s+/, '');
}

function baseLabel(row) {
  const name = (row.type || '').replace(/^(?:struct|class|union)\s+/, '');
  return row.rowKind === 'vbase' ? `virtual ${name}` : name;
}

function isUnionType(type, recordIndex) {
  if (/^union\s/.test(type)) return true;
  const rec = recordIndex.get(type.replace(/^(?:struct|class|union)\s+/, ''));
  return rec ? rec.kind === 'union' : false;
}

function resolveWithProbes(type, scalars, recordIndex, probeSizes) {
  const res = resolveTypeSize(type, scalars, recordIndex);
  if (res.bits !== undefined) return res;
  if (res.probe && probeSizes.has(res.probe)) {
    const pr = probeSizes.get(res.probe);
    return { bits: pr.bits * (res.arrayCount ?? 1), align: pr.align };
  }
  return res;
}

function endOf(row, scalars, recordIndex, probeSizes, parentEnd) {
  const res = resolveWithProbes(row.type, scalars, recordIndex, probeSizes);
  return res.bits !== undefined ? row.offsetBits + res.bits : parentEnd;
}

function estimateBits(rows, i, row, parentEnd, inUnion) {
  if (!inUnion) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].offsetBits > row.offsetBits) return rows[j].offsetBits - row.offsetBits;
    }
  }
  return Math.max(8, parentEnd - row.offsetBits);
}
