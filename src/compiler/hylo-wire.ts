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
  WireGroup,
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
  /**
   * The parts of this part's own type, at offsets from the same instance.
   *
   * Absent from a module built before the compiler reported containment, which
   * is why every read of it is optional: an older module still draws, flat.
   */
  parts?: HyloPart[];
  /** Whether this part's type is an enum, whose own parts overlap. */
  isEnum?: boolean;
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

/**
 * A source region as the wire's location, or `null` when there is none.
 *
 * The file is left empty and `isMainFile` is true: one source is submitted per
 * query, so everything with a region is in it, and a part declared elsewhere
 * (a standard-library type) carries no region at all.
 */
const location = (r: HyloRegion | null | undefined): WireLocation | null =>
  r === null || r === undefined
    ? null
    : { file: '', line: r.line, col: r.column, endCol: r.endColumn, isMainFile: true };

/**
 * The byte ranges of `size` bytes that no part covers.
 *
 * Takes every part at every depth, since a byte covered by a nested member is
 * covered; passing only the top level would report a record of records as
 * entirely padding.
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

/**
 * The leaves, groups and tree of one laid-out type.
 *
 * A part with parts of its own is a group, exactly as a record-typed member is
 * in clang's answer, and its own parts are leaves beneath it. Expressing the
 * two backends in one shape is what keeps the views from having to know which
 * compiler answered: `model-laws` then holds both to the same rules.
 */
function build(
  layout: HyloLayout,
  id: number,
  /** The id of the record laid out for a type, where this answer laid one out. */
  idOfType: (type: string) => number | null,
): { leaves: WireLeaf[]; groups: WireGroup[]; tree: WireNode[] } {
  const leaves: WireLeaf[] = [];
  const groups: WireGroup[] = [];

  // `path` names what *encloses* a member, not the member: a leaf directly in
  // the record has an empty one, and a leaf inside `hdr` has `['hdr']`. The
  // table indents by it, so including the member's own name indents it under
  // itself.
  const walk = (
    parts: HyloPart[],
    owner: string,
    ancestors: string[],
    isEnum: boolean,
  ): WireNode[] => {
    // An enum's payloads share an offset; the discriminator that follows them
    // does not. `overlaps` is what tells the grid to stack them.
    const discriminator = isEnum ? parts.length - 1 : -1;

    return parts.map((p, i) => {
      const overlaps = isEnum && i !== discriminator && parts.length > 2;
      const nested = p.parts ?? [];

      if (nested.length === 0) {
        const ref = leaves.length;
        leaves.push({
          kind: 'field',
          name: p.name,
          type: p.type,
          offsetBits: p.offset * 8,
          sizeBits: p.size * 8,
          alignBits: p.alignment * 8,
          path: ancestors,
          ownerId: id,
          ownerName: owner,
          // A zero-sized part occupies nothing, so nothing is drawn for it, but
          // it still has an offset. `Void` payloads of an enum are the common case.
          sharesAddress: p.size === 0,
          location: location(p.site),
        });
        return { kind: 'leaf', ref, overlaps, children: [] };
      }

      // Reserve the group's index before walking into it, so a group is
      // numbered above the groups it contains rather than below them.
      const ref = groups.length;
      groups.push(null as unknown as WireGroup);
      const before = leaves.length;
      const children = walk(nested, p.type, [...ancestors, p.name], p.isEnum ?? false);
      groups[ref] = {
        kind: 'member',
        name: p.name,
        type: p.type,
        offsetBits: p.offset * 8,
        sizeBits: p.size * 8,
        typeSizeBits: p.size * 8,
        alignBits: p.alignment * 8,
        path: ancestors,
        ownerId: id,
        ownerName: owner,
        // What "inspect this member's type" opens. Null where the answer laid
        // no record out for it, which is a type from another module: there is
        // nothing to open, and the option is not offered.
        recordId: idOfType(p.type),
        isBase: false,
        isUnion: p.isEnum ?? false,
        leafIndexes: Array.from({ length: leaves.length - before }, (_, k) => before + k),
        location: location(p.site),
      };
      return { kind: 'group', ref, overlaps, children };
    });
  };

  const tree = walk(layout.parts, layout.type, [], layout.isEnum);
  return { leaves, groups, tree };
}

/** Every part, at any depth: what the byte grid and the padding scan read. */
function flatten(parts: HyloPart[]): HyloPart[] {
  return parts.flatMap((p) => [p, ...flatten(p.parts ?? [])]);
}

/**
 * One Hylo layout as the wire's record, under `id`.
 *
 * `idOfType` gives the record id for a part's type when that type is itself
 * laid out in this answer, and `null` otherwise; it is what makes a member
 * inspectable, so a type the query did not describe is simply not offered.
 */
function toRecord(
  layout: HyloLayout,
  id: number,
  idOfType: (type: string) => number | null,
): WireRecord {
  const { leaves, groups, tree } = build(layout, id, idOfType);
  const runs = paddingRuns(flatten(layout.parts), layout.size);
  return {
    id,
    // Drawn like a union, because its cases are stored one over another, but
    // named what the language names it: the overlap is `WireNode.overlaps` on
    // the payload leaves below, and the kind is only what a reader is told.
    kind: layout.isEnum ? 'enum' : 'struct',
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
      groups,
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

/**
 * The module's answer, in the shape the analyzer and the views read.
 *
 * - Total: every answer maps, including one carrying `error`, which becomes an
 *   unsuccessful response rather than throwing. A view is never handed nothing.
 * - Record ids are positions in `answer.layouts`, so a member whose type this
 *   answer laid out names it in `WireGroup.recordId` and can be opened.
 * - Offsets arrive absolute, from the start of the described instance, at every
 *   depth; they are converted to bits and not rebased.
 * - A part with parts of its own becomes a group, and only its leafmost parts
 *   become leaves, which is what lets one table draw this and clang's answer.
 */
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

  // A record's id is its position, so a member whose type this answer laid out
  // can name it and be opened.
  const layouts = answer.layouts ?? [];
  const ids = new Map(layouts.map((l, i) => [l.type, i]));
  const idOfType = (type: string) => ids.get(type) ?? null;

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
    records: layouts.map((l, i) => toRecord(l, i, idOfType)),
  };
}
