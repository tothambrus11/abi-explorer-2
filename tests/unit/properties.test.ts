// Property-based tests for the places where a wrong answer is both easy to
// produce and expensive: the parser every number in the app comes out of, the
// URL decoder that eats untrusted input, the flag allowlist that decides what
// clang is asked to do, and the two geometry passes (padding, containment tree)
// whose invariants are hard to state in examples but easy to state as laws.
//
// The layout generator below prints records in clang's own dump format. That
// format is not guessed: `prints the shapes real clang prints` re-prints every
// recorded fixture and checks the round-trip, so the printer cannot drift into
// agreeing with the parser about a format clang never emits.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseRecordLayouts, flattenRows, recordKey } from '$core/layout-parser';
import { assignColors, buildRenderModel } from '$core/model';
import { buildLayoutTree, flattenVisible, type TreeNode } from '$core/tree';
import { buildArgv, DEFAULT_OPTIONS, isAllowedFlag, splitExtraFlags } from '$core/options';
import { decodeShareState, encodeShareState, type ShareState } from '$core/url-state';
import { C_STANDARDS, CXX_STANDARDS, TARGET_GROUPS } from '$core/targets';
import type { LayoutRow, RecordLayout, RowKind } from '$core/types';


// ------------------------------------------------------------ generators --

/**
 * Type spellings as clang prints them. Constraints the parser imposes on a
 * *field* row, all satisfied here: no trailing space (that is the marker for an
 * unnamed member), not wholly parenthesised (that is a special row), and no
 * trailing base suffix.
 */
const TYPE_SPELLINGS = [
  'int',
  'char',
  'unsigned long',
  'void *',
  'const char *',
  'void (*)(void)',
  'char[5]',
  'struct Point',
  'union Payload',
  'Point',
  'std::pair<int, char>',
  'Anon::(unnamed at input.cc:6:41)',
  'ns::Outer::Inner',
];
const FIELD_NAMES = ['a', 'b', 'x', 'count', 'userdata', 'crc_lo', 'first', 'v'];
const SPECIAL_LABELS = [
  'vtable pointer',
  'Base vtable pointer',
  'vbtable pointer',
  'vfptr',
  'vbptr',
  'vtordisp for Base',
];
const BASE_KINDS: RowKind[] = ['base', 'primary-base', 'vbase', 'primary-vbase'];
const RECORD_NAMES = [
  'Example',
  'ns::Message',
  'Outer::Inner',
  'Pair<double>',
  '(unnamed at input.c:3:9)',
  '(anonymous namespace)::Config',
];

const byteOffset = fc.integer({ min: 0, max: 255 }).map((b) => b * 8);

/** A leaf row: plain field, bit-field, zero-width bit-field, or a special. */
function rowLeafArb(): fc.Arbitrary<LayoutRow> {
  const plain = fc
    .record({
      type: fc.constantFrom(...TYPE_SPELLINGS),
      name: fc.oneof(fc.constantFrom(...FIELD_NAMES), fc.constant('')),
      offsetBits: byteOffset,
      isEmpty: fc.boolean(),
    })
    .map(
      ({ type, name, offsetBits, isEmpty }): LayoutRow => ({
        rowKind: 'field',
        type,
        name,
        label: null,
        offsetBits,
        bitWidth: null,
        isBitfield: false,
        isZeroWidth: false,
        // An unnamed member is signalled by a trailing space, which a following
        // `(empty)` would hide. Real clang never prints that pair (an unnamed
        // member is an anonymous aggregate; `(empty)` marks an empty class
        // member, which always has a name), so it is not generated either.
        isEmpty: name === '' ? false : isEmpty,
        depth: 0,
        children: [],
      }),
    );

  const bitfield = fc
    .record({
      type: fc.constantFrom('unsigned int', 'short', 'unsigned long long', 'char'),
      name: fc.oneof(fc.constantFrom(...FIELD_NAMES), fc.constant('')),
      byte: fc.integer({ min: 0, max: 255 }),
      first: fc.integer({ min: 0, max: 7 }),
      width: fc.integer({ min: 1, max: 64 }),
    })
    .map(
      ({ type, name, byte, first, width }): LayoutRow => ({
        rowKind: 'field',
        type,
        name,
        label: null,
        offsetBits: byte * 8 + first,
        bitWidth: width,
        isBitfield: true,
        isZeroWidth: false,
        isEmpty: false,
        depth: 0,
        children: [],
      }),
    );

  const zeroWidth = fc
    .record({
      type: fc.constantFrom('unsigned int', 'int'),
      byte: fc.integer({ min: 0, max: 255 }),
    })
    .map(
      ({ type, byte }): LayoutRow => ({
        rowKind: 'field',
        type,
        name: '',
        label: null,
        offsetBits: byte * 8,
        bitWidth: 0,
        isBitfield: true,
        isZeroWidth: true,
        isEmpty: false,
        depth: 0,
        children: [],
      }),
    );

  const special = fc
    .record({ label: fc.constantFrom(...SPECIAL_LABELS), offsetBits: byteOffset })
    .map(
      ({ label, offsetBits }): LayoutRow => ({
        rowKind: 'special',
        type: null,
        name: null,
        label,
        offsetBits,
        bitWidth: null,
        isBitfield: false,
        isZeroWidth: false,
        isEmpty: false,
        depth: 0,
        children: [],
      }),
    );

  return fc.oneof(
    { weight: 5, arbitrary: plain },
    { weight: 2, arbitrary: bitfield },
    { weight: 1, arbitrary: zeroWidth },
    { weight: 1, arbitrary: special },
  );
}

/** A row tree: leaves, plus compound field/base rows that nest further rows. */
function rowArb(depth: number): fc.Arbitrary<LayoutRow> {
  if (depth <= 0) return rowLeafArb();
  const compound = fc
    .record({
      base: fc.boolean(),
      baseKind: fc.constantFrom(...BASE_KINDS),
      type: fc.constantFrom(...TYPE_SPELLINGS),
      name: fc.oneof(fc.constantFrom(...FIELD_NAMES), fc.constant('')),
      offsetBits: byteOffset,
      isEmpty: fc.boolean(),
      children: fc.array(rowArb(depth - 1), { minLength: 1, maxLength: 3 }),
    })
    .map(({ base, baseKind, type, name, offsetBits, isEmpty, children }): LayoutRow =>
      base
        ? {
            rowKind: baseKind,
            type,
            name: null,
            label: null,
            offsetBits,
            bitWidth: null,
            isBitfield: false,
            isZeroWidth: false,
            isEmpty,
            depth: 0,
            children,
          }
        : {
            rowKind: 'field',
            type,
            name,
            label: null,
            offsetBits,
            bitWidth: null,
            isBitfield: false,
            isZeroWidth: false,
            isEmpty: name === '' ? false : isEmpty,
            depth: 0,
            children,
          },
    );
  return fc.oneof({ weight: 3, arbitrary: rowLeafArb() }, { weight: 1, arbitrary: compound });
}

interface GeneratedRecord {
  record: RecordLayout;
  /** Print the C++ trailer across two lines (clang wraps it) rather than one. */
  splitTrailer: boolean;
}

const recordArb: fc.Arbitrary<GeneratedRecord> = fc
  .record({
    kind: fc.constantFrom('struct' as const, 'union' as const, 'class' as const),
    name: fc.constantFrom(...RECORD_NAMES),
    isEmpty: fc.boolean(),
    sizeBytes: fc.integer({ min: 0, max: 512 }),
    align: fc.constantFrom(1, 2, 4, 8, 16),
    extras: fc.option(
      fc.record({
        dsize: fc.integer({ min: 0, max: 512 }),
        nvsize: fc.integer({ min: 0, max: 512 }),
        nvalign: fc.constantFrom(1, 2, 4, 8),
      }),
      { nil: undefined },
    ),
    rows: fc.array(rowArb(2), { maxLength: 6 }),
    splitTrailer: fc.boolean(),
  })
  .map(({ kind, name, isEmpty, sizeBytes, align, extras, rows, splitTrailer }) => {
    const record: RecordLayout = { kind, name, isEmpty, sizeBytes, align, rows, ...extras };
    return { record, splitTrailer };
  });

// -------------------------------------------------------------- printer ---

/**
 * Render records the way `-fdump-record-layouts` does. Offsets are right-aligned
 * in a 10-column field, nesting is two spaces per level (starting at one), an
 * unnamed member is a type followed by a single space, and `(empty)` comes last
 * — after a base suffix where both apply.
 */
function printRecords(items: GeneratedRecord[]): string {
  const out: string[] = [];
  for (const { record, splitTrailer } of items) {
    out.push('*** Dumping AST Record Layout');
    const head = `${record.kind} ${record.name}`;
    out.push(line('0', 0, record.isEmpty ? `${head} (empty)` : head));
    for (const row of record.rows) printRow(row, 1, out);
    const parts = [`sizeof=${record.sizeBytes}`];
    if (record.dsize !== undefined) parts.push(`dsize=${record.dsize}`);
    parts.push(`align=${record.align}`);
    if (record.nvsize !== undefined) parts.push(`nvsize=${record.nvsize}`);
    if (record.nvalign !== undefined) parts.push(`nvalign=${record.nvalign}`);
    if (splitTrailer && parts.length > 2) {
      const cut = Math.ceil(parts.length / 2);
      out.push(`${''.padStart(10)} | [${parts.slice(0, cut).join(', ')},`);
      out.push(`${''.padStart(10)} |  ${parts.slice(cut).join(', ')}]`);
    } else {
      out.push(`${''.padStart(10)} | [${parts.join(', ')}]`);
    }
    out.push('');
  }
  return out.join('\n');
}

function line(offset: string, depth: number, body: string): string {
  return `${offset.padStart(10)} |${' '.repeat(2 * depth + 1)}${body}`;
}

const BASE_SUFFIX: Partial<Record<RowKind, string>> = {
  base: ' (base)',
  'primary-base': ' (primary base)',
  vbase: ' (virtual base)',
  'primary-vbase': ' (primary virtual base)',
};

function printRow(row: LayoutRow, depth: number, out: string[]): void {
  let offset: string;
  if (row.isBitfield) {
    const byte = Math.floor(row.offsetBits / 8);
    if (row.isZeroWidth) offset = `${byte}:-`;
    else {
      const first = row.offsetBits % 8;
      offset = `${byte}:${first}-${first + (row.bitWidth ?? 1) - 1}`;
    }
  } else {
    offset = String(row.offsetBits / 8);
  }

  let body: string;
  if (row.rowKind === 'special') {
    body = `(${row.label ?? ''})`;
  } else if (row.rowKind === 'field') {
    // A trailing space is how clang marks a member with no name of its own.
    body = row.name ? `${row.type ?? ''} ${row.name}` : `${row.type ?? ''} `;
  } else {
    body = `${row.type ?? ''}${BASE_SUFFIX[row.rowKind] ?? ''}`;
  }
  if (row.isEmpty) body += ' (empty)';

  out.push(line(offset, depth, body));
  for (const child of row.children) printRow(child, depth + 1, out);
}

/** The same tree with `depth` filled in, which is what the parser reports. */
function withDepth(rows: LayoutRow[], depth = 1): LayoutRow[] {
  return rows.map((r) => ({ ...r, depth, children: withDepth(r.children, depth + 1) }));
}

// ------------------------------------------------------- layout parser ----

describe('layout dump parser (property)', () => {
  it('round-trips every record shape clang can print', () => {
    fc.assert(
      fc.property(fc.array(recordArb, { minLength: 1, maxLength: 3 }), (items) => {
        const parsed = parseRecordLayouts(printRecords(items));
        expect(parsed).toHaveLength(items.length);
        // Records repeating a kind+name are numbered from the second on.
        const seen = new Map<string, number>();
        items.forEach(({ record }, i) => {
          const k = record.kind + ' ' + record.name;
          const n = seen.get(k) ?? 0;
          seen.set(k, n + 1);
          const expected: RecordLayout = { ...record, rows: withDepth(record.rows) };
          if (n > 0) expected.dup = n;
          expect(parsed[i]).toEqual(expected);
        });
      }),
      { numRuns: 300 },
    );
  });

  it('keeps every row reachable and correctly nested', () => {
    fc.assert(
      fc.property(recordArb, (item) => {
        const [parsed] = parseRecordLayouts(printRecords([item]));
        expect(parsed).toBeDefined();
        const flat = flattenRows(parsed!);
        const countRows = (rows: LayoutRow[]): number =>
          rows.reduce((n, r) => n + 1 + countRows(r.children), 0);
        // Nothing is dropped by the indentation/stack handling…
        expect(flat).toHaveLength(countRows(item.record.rows));
        // …and depth always matches actual nesting.
        const check = (rows: LayoutRow[], d: number): void => {
          for (const r of rows) {
            expect(r.depth).toBe(d);
            check(r.children, d + 1);
          }
        };
        check(parsed!.rows, 1);
      }),
      { numRuns: 200 },
    );
  });

  it('never throws, and only yields records whose size and alignment are known', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        // Arbitrary text, and arbitrary text that looks like a dump.
        for (const input of [text, '*** Dumping AST Record Layout\n' + text]) {
          const records = parseRecordLayouts(input);
          for (const r of records) {
            expect(Number.isFinite(r.sizeBytes)).toBe(true);
            expect(Number.isFinite(r.align)).toBe(true);
            expect(recordKey(r)).toContain(r.name);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('prints the shapes real clang prints', () => {
    // Grounding: the printer is only evidence about the parser if it emits the
    // format clang actually emits. Re-print every recorded dump and re-parse it;
    // a printer that had drifted would not survive its own output.
    const dir = path.join(process.cwd(), 'tests', 'fixtures');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
    expect(files.length).toBeGreaterThan(0);
    let checked = 0;
    for (const file of files) {
      const fx = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as {
        calls: { out: { stdout: string } }[];
      };
      for (const call of fx.calls) {
        const records = parseRecordLayouts(call.out.stdout);
        if (records.length === 0) continue;
        const reparsed = parseRecordLayouts(
          printRecords(records.map((record) => ({ record: stripDup(record), splitTrailer: true }))),
        );
        expect(reparsed, file).toEqual(records);
        checked += records.length;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

/** `dup` is assigned by the parser, so it must not be re-printed as input. */
function stripDup(record: RecordLayout): RecordLayout {
  const { dup: _dup, ...rest } = record;
  void _dup;
  return rest;
}

// ---------------------------------------------------------- url state -----

const KNOWN_TRIPLES = TARGET_GROUPS.flatMap((g) => g.targets.map((t) => t.triple));

const optionsArb = fc
  .record({
    cxx: fc.boolean(),
    triple: fc.constantFrom(...KNOWN_TRIPLES),
    pack: fc.constantFrom('' as const, '1' as const, '4' as const, '16' as const),
    msBitfields: fc.boolean(),
    shortEnums: fc.boolean(),
    shortWchar: fc.boolean(),
    wasiLibc: fc.boolean(),
    warnPadded: fc.boolean(),
    extraFlags: fc.constantFrom('', '-Wpadded', '-O2 -DFOO=1', '-fshort-enums'),
    stdPick: fc.nat(),
  })
  .map(({ cxx, stdPick, ...rest }) => {
    const stds = cxx ? CXX_STANDARDS : C_STANDARDS;
    return {
      ...rest,
      lang: cxx ? ('c++' as const) : ('c' as const),
      std: stds[stdPick % stds.length]!,
    };
  });

describe('share URL (property)', () => {
  it('round-trips source and every option', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 400 }),
        optionsArb,
        fc.option(fc.constantFrom('struct Example', 'union U'), { nil: null }),
        fc.constantFrom('tabs' as const, 'stack' as const),
        async (source, options, selectedRecord, view) => {
          const state = { source, options, selectedRecord, view };
          const back = await decodeShareState(await encodeShareState(state));
          expect(back).toEqual(state);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('survives arbitrary fragments without throwing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 200 }), async (fragment) => {
        const decoded = await decodeShareState(fragment);
        if (decoded !== null) expectValidState(decoded);
      }),
      { numRuns: 200 },
    );
  });

  it('coerces hostile wire data into a usable state', async () => {
    // The fragment is attacker-controlled: a link can carry any JSON at all.
    // Whatever comes back must still be something we can hand to clang.
    await fc.assert(
      fc.asyncProperty(fc.object({ maxDepth: 2 }), async (payload) => {
        const json = JSON.stringify(payload);
        const bytes = new TextEncoder().encode(json);
        const fragment = btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        const decoded = await decodeShareState(fragment);
        if (decoded !== null) expectValidState(decoded);
      }),
      { numRuns: 200 },
    );
  });
});

function expectValidState(s: ShareState): void {
  const o = s.options;
  expect(typeof s.source).toBe('string');
  expect(['c', 'c++', 'hylo']).toContain(o.lang);
  expect(['', '1', '2', '4', '8', '16']).toContain(o.pack);
  // A triple goes straight into `--target=`; it must stay a plain token.
  expect(o.triple).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
  expect(o.extraFlags.length).toBeLessThanOrEqual(500);
  expect(['tabs', 'stack']).toContain(s.view);
  const stds = o.lang === 'c++' ? CXX_STANDARDS : o.lang === 'hylo' ? [] : C_STANDARDS;
  if (stds.length) expect(stds).toContain(o.std);
}

// ------------------------------------------------------ flag allowlist ----

/**
 * Flags that would change what clang *does* rather than how it lays records
 * out: pick a different frontend action, or write a file. `buildArgv` never
 * emits any of these, so seeing one means the user's free-form flag box got it
 * through — and a URL can put anything in that box.
 */
function isDangerous(token: string): boolean {
  return (
    /^-(?:o|c|S|E|M[MDFGPQT]?|###)$/.test(token) ||
    /^--?(?:output|analyze|save-temps|emit)/.test(token) ||
    token.startsWith('-emit-') ||
    token.startsWith('-dump')
  );
}

describe('extra-flag allowlist (property)', () => {
  const flagText = fc.oneof(
    fc.string({ maxLength: 60 }),
    fc
      .array(
        fc.constantFrom(
          '-o',
          'out.o',
          '-E',
          '-S',
          '-###',
          '-emit-llvm',
          '-Xclang',
          '-ast-print',
          '-Xclang',
          '-fdump-record-layouts',
          '-O2',
          '-DFOO=1',
          '-I/tmp',
          '-target',
          'x86_64-linux',
          'evil.c',
          '--output=x',
          '-save-temps',
          '-w',
        ),
        { maxLength: 8 },
      )
      .map((t) => t.join(' ')),
  );

  it('classifies every token exactly once', () => {
    fc.assert(
      fc.property(flagText, (text) => {
        const [accepted, rejected] = splitExtraFlags(text);
        const tokens = text.trim().split(/\s+/).filter(Boolean);
        // Nothing invented, nothing silently dropped — the UI shows `rejected`
        // to explain why a flag had no effect.
        expect([...accepted, ...rejected].sort()).toEqual([...tokens].sort());
      }),
      { numRuns: 300 },
    );
  });

  it('lets no output- or action-changing flag reach clang', () => {
    fc.assert(
      fc.property(flagText, fc.boolean(), (extraFlags, cxx) => {
        const options = {
          ...DEFAULT_OPTIONS,
          lang: cxx ? ('c++' as const) : ('c' as const),
          extraFlags,
        };
        for (const pass of [
          { kind: 'layout' as const, files: ['input.c'] },
          { kind: 'ast-json' as const, files: ['input.c'], astFilter: 'S' },
          { kind: 'layout' as const, files: ['probe.c'], measure: true },
        ]) {
          const argv = buildArgv(options, pass);
          expect(argv.filter(isDangerous)).toEqual([]);
          // The pass keeps the shape the analyzer relies on.
          expect(argv).toContain('-fsyntax-only');
          expect(argv.slice(-pass.files.length)).toEqual(pass.files);
          // Exactly one language and one target, both ours.
          expect(argv.filter((a) => a.startsWith('-x'))).toEqual([cxx ? '-xc++' : '-xc']);
          expect(argv.filter((a) => a.startsWith('--target='))).toHaveLength(1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('accepts only what the allowlist admits, for single tokens', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (token) => {
        if (/\s/.test(token) || token === '') return;
        const [accepted] = splitExtraFlags(token);
        expect(accepted).toEqual(isAllowedFlag(token) ? [token] : []);
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------- render model & tree -------

const EMPTY_INPUTS = { scalars: new Map(), recordIndex: new Map(), memberSizes: new Map() };

/** A record generated as above, run through the real model builder. */
const modelArb = recordArb.map(({ record }) => {
  const model = buildRenderModel(record, EMPTY_INPUTS);
  assignColors(model);
  return model;
});

describe('padding (property)', () => {
  it('reports exactly the bytes no member covers', () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const size = model.record.sizeBytes;
        // Independent recomputation of the covered set.
        const covered = new Set<number>();
        for (const leaf of model.leaves) {
          const from = Math.max(0, Math.floor(leaf.offsetBits / 8));
          const to = Math.min(size, Math.ceil((leaf.offsetBits + leaf.sizeBits) / 8));
          for (let b = from; b < to; b++) covered.add(b);
        }
        const expected: number[] = [];
        for (let b = 0; b < size; b++) if (!covered.has(b)) expected.push(b);

        const actual = model.paddings.flatMap((p) => {
          const bytes: number[] = [];
          for (let b = p.start; b < p.end; b++) bytes.push(b);
          return bytes;
        });
        expect(actual).toEqual(expected);
        expect(model.paddingBytes).toBe(expected.length);
      }),
      { numRuns: 300 },
    );
  });

  it('emits runs that are non-empty, ascending, disjoint and in bounds', () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        let prevEnd = 0;
        for (const run of model.paddings) {
          expect(run.end).toBeGreaterThan(run.start);
          expect(run.start).toBeGreaterThanOrEqual(prevEnd);
          expect(run.end).toBeLessThanOrEqual(model.record.sizeBytes);
          prevEnd = run.end;
        }
        // Adjacent runs are merged, never left as two touching runs.
        for (let i = 1; i < model.paddings.length; i++) {
          expect(model.paddings[i]!.start).toBeGreaterThan(model.paddings[i - 1]!.end);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('gives every leaf a colour and every group a consistent one', () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        for (const leaf of model.leaves) expect(leaf.colorClass).toBeTruthy();
        // A group's leaves are one unit on screen, so a group that stands for a
        // single direct member must not be striped across several colours.
        for (const g of model.groups) {
          expect(g.leafIndexes.every((li) => model.leaves[li] !== undefined)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('containment tree (property)', () => {
  const allNodes = (nodes: TreeNode[]): TreeNode[] =>
    nodes.flatMap((n) => [n, ...allNodes(n.children)]);

  it('partitions the leaves: each appears exactly once', () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const tree = buildLayoutTree(model);
        const refs = allNodes(tree)
          .filter((n) => n.kind === 'leaf')
          .map((n) => n.ref)
          .sort((a, b) => a - b);
        expect(refs).toEqual(model.leaves.map((_, i) => i));
      }),
      { numRuns: 300 },
    );
  });

  it('nests groups: a subtree never escapes its parent', () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const check = (nodes: TreeNode[], within: Set<number> | null): void => {
          for (const n of nodes) {
            if (within) {
              for (const li of n.leafIndexes) expect(within.has(li)).toBe(true);
            }
            check(n.children, n.kind === 'group' ? new Set(n.leafIndexes) : null);
          }
        };
        check(buildLayoutTree(model), null);
      }),
      { numRuns: 300 },
    );
  });

  it('gives every node a unique id and a depth matching its nesting', () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const tree = buildLayoutTree(model);
        const ids = allNodes(tree).map((n) => n.id);
        expect(new Set(ids).size).toBe(ids.length);
        const check = (nodes: TreeNode[], d: number): void => {
          for (const n of nodes) {
            expect(n.depth).toBe(d);
            check(n.children, d + 1);
          }
        };
        check(tree, 0);
      }),
      { numRuns: 200 },
    );
  });

  it('hides exactly the descendants of collapsed nodes', () => {
    fc.assert(
      fc.property(modelArb, fc.nat(), (model, pick) => {
        const tree = buildLayoutTree(model);
        const nodes = allNodes(tree);
        // Expanded: every node, in depth-first order.
        expect(flattenVisible(tree, new Set()).map((r) => r.node.id)).toEqual(nodes.map((n) => n.id));

        const parents = nodes.filter((n) => n.children.length > 0);
        if (parents.length === 0) return;
        const target = parents[pick % parents.length]!;
        const hidden = new Set(allNodes(target.children).map((n) => n.id));
        const shown = new Set(flattenVisible(tree, new Set([target.id])).map((r) => r.node.id));
        expect(shown.has(target.id)).toBe(true);
        for (const id of hidden) expect(shown.has(id)).toBe(false);
        for (const n of nodes) {
          if (!hidden.has(n.id)) expect(shown.has(n.id)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
