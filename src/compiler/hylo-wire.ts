// What the Hylo module answers, as the views already read it.
//
// The two backends compute different things. clang lays out a translation unit
// full of records with bases, bit-fields and nesting; Hylo lays out one type at
// a time, and its parts are flat. Rather than teach every view a second shape,
// the smaller answer is expressed in the larger one: a Hylo struct is a record
// whose leaves are its stored properties, and a Hylo enum is a union whose
// leaves are its payloads plus the discriminator that follows them.
//
// The one thing worth knowing while reading this: Hylo stores members in order
// of decreasing alignment, so declaration order is not storage order. Parts
// arrive in declaration order carrying the offset they were given, which is
// exactly what the grid wants, and exactly why the field table's rows are not
// sorted by offset.

import type {
  WireDiagnostic,
  WireLeaf,
  WireLocation,
  WireNode,
  WireRecord,
  WireResponse,
} from '$core/render';

/** A region of the queried source, 1-based, as the module reports one. */
export interface HyloRegion {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** One stored property, or one case of an enum, or an enum's discriminator. */
export interface HyloPart {
  name: string;
  type: string;
  /** Bytes from the start of an instance. */
  offset: number;
  /** Bytes. */
  size: number;
  /** Bytes. */
  alignment: number;
  site?: HyloRegion | null;
}

/** One laid-out type. */
export interface HyloLayout {
  type: string;
  /** Bytes. */
  size: number;
  /** Bytes. */
  alignment: number;
  /**
   * Every part but the last is a payload stored at the same offset as the
   * others; the last is the discriminator.
   */
  isEnum: boolean;
  parts: HyloPart[];
  site?: HyloRegion | null;
}

/** What `hylo_query` answers. */
export interface HyloAnswer {
  layouts?: HyloLayout[];
  diagnostics?: { level: string; message: string; site: HyloRegion }[];
  /** Set instead of the above when the module could not serve the request at all. */
  error?: string;
}

/** The name under which a Hylo layout is reported, since Hylo has one ABI. */
export const HYLO_TRIPLE = 'hylo';

const location = (r: HyloRegion | null | undefined): WireLocation | null =>
  r === null || r === undefined
    ? null
    : { file: '', line: r.line, col: r.column, endCol: r.endColumn, isMainFile: true };

/**
 * The byte ranges of `size` bytes that no part covers.
 *
 * Hylo reorders members by alignment, which mostly removes padding rather than
 * creating it, but not always: a record's size is rounded to nothing, so the
 * gap of a trailing small member is real, and an enum whose payloads differ in
 * size leaves the shorter ones' remainder unused.
 */
function paddingRuns(parts: HyloPart[], size: number): { startBits: number; endBits: number }[] {
  const covered = new Uint8Array(size);
  for (const p of parts) covered.fill(1, p.offset, Math.min(p.offset + p.size, size));

  const runs: { startBits: number; endBits: number }[] = [];
  let start = -1;
  for (let i = 0; i <= size; i++) {
    const free = i < size && covered[i] === 0;
    if (free && start < 0) start = i;
    else if (!free && start >= 0) {
      runs.push({ startBits: start * 8, endBits: i * 8 });
      start = -1;
    }
  }
  return runs;
}

function toRecord(layout: HyloLayout, id: number): WireRecord {
  const owner = layout.type;
  // An enum's payloads share an offset; the discriminator that follows them
  // does not. `overlaps` is what tells the grid to stack them.
  const discriminator = layout.isEnum ? layout.parts.length - 1 : -1;

  const leaves: WireLeaf[] = layout.parts.map((p) => ({
    kind: 'field',
    name: p.name,
    type: p.type,
    offsetBits: p.offset * 8,
    sizeBits: p.size * 8,
    alignBits: p.alignment * 8,
    path: [p.name],
    ownerId: id,
    ownerName: owner,
    // A zero-sized part occupies nothing, so nothing is drawn for it, but it
    // still has an offset. `Void` payloads of an enum are the common case.
    sharesAddress: p.size === 0,
    location: location(p.site),
  }));

  const tree: WireNode[] = leaves.map((_, i) => ({
    kind: 'leaf',
    ref: i,
    overlaps: layout.isEnum && i !== discriminator && layout.parts.length > 2,
    children: [],
  }));

  const runs = paddingRuns(layout.parts, layout.size);
  return {
    id,
    // A Hylo enum's cases are stored one over another, which is what this
    // app's views mean by a union. Hylo's `enum` is a sum type rather than
    // C's, so "enum" would name the wrong thing to a reader who knows C.
    kind: layout.isEnum ? 'union' : 'struct',
    name: layout.type,
    qualifiedName: layout.type,
    printedName: layout.type,
    isAnonymous: false,
    isEmpty: layout.size === 0,
    // Only what the query's own source declares has a region, so this is also
    // the test for whether the user wrote it.
    isUserCode: layout.site !== null && layout.site !== undefined,
    parentRecordId: null,
    location: location(layout.site),
    range:
      layout.site === null || layout.site === undefined
        ? null
        : {
            line: layout.site.line,
            col: layout.site.column,
            endLine: layout.site.endLine,
            endCol: layout.site.endColumn,
          },
    sizeBits: layout.size * 8,
    alignBits: layout.alignment * 8,
    // Hylo has no notion of these: no bases, so no non-virtual subobject, and
    // no preferred alignment distinct from the required one. Reporting them
    // equal is what keeps the summary from listing them as surprises.
    dataSizeBits: layout.size * 8,
    nonVirtualSizeBits: layout.size * 8,
    nonVirtualAlignBits: layout.alignment * 8,
    preferredAlignBits: layout.alignment * 8,
    fields: layout.parts.map((p) => ({
      name: p.name,
      typeSpelling: p.type,
      canonicalTypeSpelling: p.type,
      offsetBits: p.offset * 8,
      sizeBits: p.size * 8,
      alignBits: p.alignment * 8,
      explicitAlignBits: null,
      location: location(p.site),
    })),
    render: {
      leaves,
      groups: [],
      markers: [],
      tree,
      paddingRuns: runs,
      paddingBytes: runs.reduce((n, r) => n + (r.endBits - r.startBits) / 8, 0),
    },
  };
}

const SEVERITY: Record<string, WireDiagnostic['severity']> = {
  error: 'error',
  warning: 'warning',
  note: 'note',
};

/** The module's answer, in the shape the analyzer and the views read. */
export function toWireResponse(answer: HyloAnswer, version: string): WireResponse {
  if (answer.error !== undefined) {
    return {
      ok: false,
      error: answer.error,
      exitCode: 1,
      clangVersion: version,
      target: null,
      headers: null,
      diagnostics: [],
      diagnosticsText: answer.error,
      typedefs: [],
      records: [],
    };
  }

  const diagnostics: WireDiagnostic[] = (answer.diagnostics ?? []).map((d) => ({
    severity: SEVERITY[d.level] ?? 'error',
    message: d.message,
    location: location(d.site),
    ranges: [],
  }));

  return {
    ok: true,
    error: null,
    exitCode: diagnostics.some((d) => d.severity === 'error') ? 1 : 0,
    clangVersion: version,
    // Hylo describes one ABI so far, whose word is 64 bits wide.
    target: { pointerSizeBits: 64, normalizedTriple: HYLO_TRIPLE },
    headers: null,
    diagnostics,
    diagnosticsText: (answer.diagnostics ?? [])
      .map((d) => `${String(d.site.line)}:${String(d.site.column)}: ${d.level}: ${d.message}`)
      .join('\n'),
    typedefs: [],
    records: (answer.layouts ?? []).map(toRecord),
  };
}
