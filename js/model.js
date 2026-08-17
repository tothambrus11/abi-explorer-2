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
  const unresolved = new Set();
  const sizeBits = record.sizeBytes * 8;

  const ptrBits = scalars.get('ptr') ? scalars.get('ptr').size * 8 : null;

  const visit = (rows, path, parentEnd, inUnion) => {
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
          sizeBits: ptrBits ?? 0,
          estimated: ptrBits === null,
          depth: path.length,
        });
        continue;
      }

      const isBase = row.rowKind !== 'field';
      if (isBase) {
        if (row.isEmpty) {
          markers.push({ kind: 'empty-base', row, path, name: row.type, offsetBits: row.offsetBits });
        }
        visit(row.children, [...path, baseLabel(row)], parentEnd, inUnion);
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
            offsetBits: row.offsetBits, sizeBits: row.bitWidth,
            estimated: false, depth: path.length,
          });
        }
        continue;
      }

      if (row.children.length > 0) {
        // Record-typed member with inline children: recurse; the member's own
        // extent is implied by its children plus its record's size for padding.
        visit(row.children, pathName, endOf(row, scalars, recordIndex, probeSizes, parentEnd), inUnion || isUnionType(row.type, recordIndex));
        // Also record the member itself as a group extent (not a leaf).
        continue;
      }

      const res = resolveWithProbes(row.type, scalars, recordIndex, probeSizes);
      let bits = res.bits, estimated = false;
      if (bits === undefined) {
        if (res.probe) unresolved.add(res.probe);
        // Estimate: to next sibling's offset, or to parent end.
        bits = estimateBits(rows, i, row, parentEnd, inUnion);
        estimated = true;
      }
      leaves.push({
        kind: 'field', row, path,
        name: row.name || '(anonymous)', type: row.type,
        offsetBits: row.offsetBits, sizeBits: bits,
        estimated, depth: path.length,
      });
    }
  };

  visit(record.rows, [], sizeBits, record.kind === 'union');

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

  return { record, leaves, markers, paddings, sizeBits, paddingBytes, unresolved: [...unresolved] };
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
    return { bits: probeSizes.get(res.probe) * (res.arrayCount ?? 1) };
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
