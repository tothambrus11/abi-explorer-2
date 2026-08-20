// The editor's per-line index.
//
// Half of these run on hand-built models, because the interesting input is a
// shape ("two declarators on one line", "the same field seen through two
// records") rather than a program. The other half run on the corpus, so the
// mapping is also checked against locations clang actually reported.

import { describe, it, expect } from 'vitest';
import { buildLineIndex, markAtColumn } from '$state/code-locations';
import { assignColors } from '$core/render';
import { anchorOf, type RenderModel } from '$core/types';
import { corpus } from './corpus';
import { group, leaf, loc, model } from './factories';

/** Colour the models the way the app does, then index them. */
function index(models: Map<string, RenderModel>) {
  for (const m of models.values()) assignColors(m);
  return buildLineIndex(models);
}

describe('buildLineIndex', () => {
  it('is empty for no models', () => {
    expect(buildLineIndex(new Map()).size).toBe(0);
  });

  it('maps each leaf to its declaration line and colours single-field lines', () => {
    const idx = index(
      new Map([
        [
          'S',
          model([leaf('a', { location: loc(2) }), leaf('b', { offsetBits: 32, location: loc(3) })]),
        ],
      ]),
    );
    expect([...idx.keys()].sort((x, y) => x - y)).toEqual([2, 3]);
    // A single field on its own line gets that leaf's colour.
    expect(idx.get(2)!.colorClass).toBe('c-1');
    expect(idx.get(3)!.colorClass).toBe('c-2');
    expect(idx.get(2)!.members).toEqual([{ record: 'S', leaf: 0 }]);
  });

  it('a line declaring several fields marks each of them', () => {
    // `uint8_t lo, hi;`: two declarators, at their own columns.
    const idx = index(
      new Map([
        [
          'S',
          model([
            leaf('lo', { location: loc(5, 11) }),
            leaf('hi', { offsetBits: 8, location: loc(5, 15) }),
          ]),
        ],
      ]),
    );
    const l = idx.get(5)!;
    expect(l.members).toHaveLength(2);
    expect(l.marks.map((m) => m.colorClass)).toEqual(['c-1', 'c-2']);
    // The line as a whole has no single colour.
    expect(l.colorClass).toBe('c-compound');
  });

  it('a compound member is one mark covering all of its leaves', () => {
    // struct Message { Header hdr; }: hdr on line 15, its fields on 4 and 5.
    const idx = index(
      new Map([
        [
          'Message',
          model(
            [
              leaf('kind', { owner: 'Header', path: ['hdr'], location: loc(4) }),
              leaf('len', { owner: 'Header', path: ['hdr'], offsetBits: 16, location: loc(5) }),
            ],
            [group('hdr', [0, 1], { location: loc(15, 17) })],
          ),
        ],
      ]),
    );
    const marks = idx.get(15)!.marks;
    expect(marks).toHaveLength(1);
    // A compound member is one unit, so it carries the colour its leaves share.
    expect(marks[0]!.colorClass).toBe('c-1');
    expect(marks[0]!.members.map((x) => x.leaf).sort()).toEqual([0, 1]);
    expect(idx.get(15)!.colorClass).toBe('c-1');
  });

  it('the same field across two record models highlights in both', () => {
    // `kind` is a top-level field of Header and lives inside Message's `hdr`.
    const idx = index(
      new Map([
        ['Header', model([leaf('kind', { owner: 'Header', location: loc(4) })])],
        [
          'Message',
          model(
            [leaf('kind', { owner: 'Header', path: ['hdr'], location: loc(4) })],
            [group('hdr', [0], { location: loc(15) })],
          ),
        ],
      ]),
    );
    const l4 = idx.get(4)!;
    expect(l4.members.map((m) => m.record).sort()).toEqual(['Header', 'Message']);
    // The primary record is the one that declares the line as its own member.
    expect(l4.primary).toBe('Header');
    expect(l4.colorClass).toBe('c-1');
  });

  it('ignores anything not written in the file the user submitted', () => {
    const outside = { file: 'string', line: 900, col: 3, endCol: 4, isMainFile: false };
    const idx = index(new Map([['S', model([leaf('a', { location: outside })])]]));
    expect(idx.size).toBe(0);
  });
});

describe('markAtColumn', () => {
  const idx = index(
    new Map([
      [
        'S',
        model([
          leaf('lo', { location: loc(5, 11) }),
          leaf('hi', { offsetBits: 8, location: loc(5, 15) }),
        ]),
      ],
    ]),
  );
  const l5 = idx.get(5)!;

  it('resolves a column to the declarator it falls in', () => {
    expect(markAtColumn(l5, 11)!.col).toBe(11);
    expect(markAtColumn(l5, 14)!.col).toBe(11); // inside `lo`, before `hi`
    expect(markAtColumn(l5, 15)!.col).toBe(15);
    expect(markAtColumn(l5, 99)!.col).toBe(15); // past the last one
    expect(markAtColumn(l5, 1)!.col).toBe(11); // before the first: the leading one
  });

  it('makes a single-declarator line one forgiving hit area', () => {
    const one = index(new Map([['S', model([leaf('a', { location: loc(2, 12) })])]]));
    const info = one.get(2)!;
    expect(info.marks).toHaveLength(1);
    expect(markAtColumn(info, 1)!.col).toBe(12);
    expect(markAtColumn(info, 80)!.col).toBe(12);
  });
});

// ------------------------------------------------------- against the corpus --

describe('the index over real answers', () => {
  const entries = corpus();

  it('has a corpus to run on', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const { name, analysis } of entries) {
    // Only the records the app would show; the rest are never indexed.
    const models = new Map(
      analysis.records.filter((r) => r.listed).map((r) => [r.key, r.model] as const),
    );
    if (models.size === 0) continue;

    it(`${name}: every mark sits where something is declared`, () => {
      const idx = buildLineIndex(models);
      for (const [line, info] of idx) {
        expect(info.marks.length, `${line}: at least one mark`).toBeGreaterThan(0);
        // Marks are ordered left to right and each covers a real span.
        const cols = info.marks.map((m) => m.col);
        expect(cols, `${line}: sorted`).toEqual([...cols].sort((a, b) => a - b));
        for (const m of info.marks) {
          expect(m.endCol, `${line}:${m.col}: non-empty`).toBeGreaterThan(m.col);
          // Anything that occupies bytes must highlight them. The converse is
          // not required: an empty base (`struct W : E {}`) is a declarator
          // worth marking in the editor that draws nothing in the grid.
          if (m.items.some((it) => it.sizeBits > 0)) {
            expect(m.members.length, `${line}:${m.col}: highlights its bytes`).toBeGreaterThan(0);
          }
          // Every member a mark points at exists in the model it names.
          for (const ref of m.members) {
            expect(
              models.get(ref.record)?.leaves[ref.leaf],
              `${line}: ${ref.record}#${ref.leaf}`,
            ).toBeDefined();
          }
        }
        expect(models.has(info.primary), `${line}: primary is on screen`).toBe(true);
      }
    });

    it(`${name}: indexes every item clang located in the file`, () => {
      const idx = buildLineIndex(models);
      for (const [key, m] of models) {
        for (const item of [...m.leaves, ...m.groups]) {
          const at = anchorOf(item.location);
          if (!at) continue;
          const info = idx.get(at.line);
          expect(info, `${key}: ${item.name} at line ${at.line}`).toBeDefined();
          // Either it has a mark of its own, or a compound member at the same
          // declarator subsumes it.
          const covering = info!.marks.filter((mk) => mk.col <= at.col);
          expect(covering.length, `${key}: ${item.name} has a mark`).toBeGreaterThan(0);
        }
      }
    });
  }
});
