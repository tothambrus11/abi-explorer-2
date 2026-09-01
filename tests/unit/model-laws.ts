// What must be true of every render model, whatever produced it.
//
// These are shared so the same laws run twice: exhaustively over the captured
// corpus (`properties.test.ts`), and over generated sources compiled for real
// (`properties.real.test.ts`). A law stated once cannot drift between the two,
// and a failure names the record either way.

import { describe, it, expect } from 'vitest';
import {
  assignColors,
  flattenVisible,
  groupColorClass,
  isTransparent,
  SPECIAL_COLOR,
} from '$core/render';
import { resolveHover, type HoverIntent } from '$state/hover';
import { buildLineIndex, COMPOUND } from '$state/code-locations';
import type { RenderModel, TreeNode } from '$core/types';

export interface Subject {
  /** Where this model came from, so a failure names it. */
  label: string;
  model: RenderModel;
  /**
   * Whether the language stores members in the order they are declared.
   *
   * C does, so its tables read down the page as memory reads across, and a
   * sibling out of offset order means the tree was built wrong. Hylo reorders
   * members by decreasing alignment and the table stays in source order, which
   * is the fact the table exists to show; the same check there would fail on
   * every correct answer.
   */
  declarationIsStorageOrder?: boolean;
}

/** How the model labels a member with no name of its own. */
const ANON_LABEL = '(anonymous)';

const allNodes = (nodes: TreeNode[]): TreeNode[] =>
  nodes.flatMap((n) => [n, ...allNodes(n.children)]);

/** The key the laws resolve hovers against; any name will do for one model. */
const KEY = 'r';

/**
 * Which bytes the grid lights when a table row is hovered, by *asking the
 * resolver*, not by restating it.
 *
 * This used to walk `node.leafIndexes` directly, on the reasoning that a row
 * contributes exactly its own leaves. That is half of what happens: a hover
 * also carries `ranges`, the whole extent of what was hovered, and `ByteGrid`
 * lights padding inside that extent as well. A law that reimplements the thing
 * it is checking can only ever agree with the version of it that was true when
 * it was written, so this one calls `resolveHover` and reads the two fields
 * `ByteGrid` reads.
 */
function litBytes(model: RenderModel, node: TreeNode): Set<number> {
  const intent: HoverIntent =
    node.kind === 'leaf'
      ? { kind: 'leaf', record: KEY, leaf: node.ref, tooltip: null }
      : { kind: 'group', record: KEY, group: node.ref, tooltip: null };
  const hover = resolveHover({
    intent,
    mouse: null,
    cursor: null,
    preferCursor: false,
    models: new Map([[KEY, model]]),
    lines: new Map(),
    records: [],
    current: KEY,
  });
  const bytes = new Set<number>();
  // A coloured cell lights when its leaf is in `members`…
  for (const m of hover.members) {
    if (m.record !== KEY) continue;
    const leaf = model.leaves[m.leaf];
    if (!leaf) continue;
    for (
      let b = Math.floor(leaf.offsetBits / 8);
      b < Math.ceil((leaf.offsetBits + leaf.sizeBits) / 8);
      b++
    ) {
      bytes.add(b);
    }
  }
  // …and a padding cell when it falls inside `ranges`.
  for (const r of hover.ranges) {
    if (r.record !== KEY) continue;
    for (let b = r.start; b < r.end; b++) bytes.add(b);
  }
  return bytes;
}

/**
 * One area per distinguishable spot on the byte map, as `ByteGrid` draws it:
 * a cell per byte, split into bit sub-cells where a bit-field lives, and each
 * hover reporting the extent of exactly the cell under the pointer.
 *
 * Byte cells are enumerated one per run of identical coverage rather than one
 * by one: between two leaf boundaries every byte is shared by the same
 * members, so a representative checks them all and a record too large for a
 * byte-by-byte walk still has every distinguishable area checked. Bit
 * sub-cells are walked exhaustively; bit-fields keep them few.
 */
function drawnAreas(model: RenderModel): { fromBit: number; toBit: number }[] {
  const size = model.record.sizeBytes;
  const cuts = new Set<number>([0, size]);
  const bitBytes = new Set<number>();
  for (const leaf of model.leaves) {
    if (leaf.sizeBits === 0) continue;
    const from = Math.floor(leaf.offsetBits / 8);
    const to = Math.min(size, Math.ceil((leaf.offsetBits + leaf.sizeBits) / 8));
    cuts.add(from);
    cuts.add(to);
    if (leaf.kind === 'bitfield') for (let b = from; b < to; b++) bitBytes.add(b);
  }
  const edges = [...cuts].sort((a, b) => a - b);
  const areas: { fromBit: number; toBit: number }[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const b = edges[i]!;
    // A bit-field's byte range starts and ends on cuts, so a run is bit-split
    // either wholly or not at all; its bits are enumerated below instead.
    if (b < size && !bitBytes.has(b)) areas.push({ fromBit: b * 8, toBit: b * 8 + 8 });
  }
  for (const b of bitBytes) {
    for (let bit = 0; bit < 8; bit++) {
      areas.push({ fromBit: b * 8 + bit, toBit: b * 8 + bit + 1 });
    }
  }
  return areas;
}

/**
 * Register every law against a set of subjects.
 *
 * `subjects` is a thunk so a suite that needs clang can defer loading it past
 * collection time, and so nothing is built for a suite that ends up skipped.
 */
export function modelLaws(what: string, subjects: () => Subject[]): void {
  const forEvery = (law: (s: Subject) => void) => {
    const all = subjects();
    expect(all.length, 'nothing to check').toBeGreaterThan(0);
    for (const s of all) law(s);
  };

  describe(`${what}: padding`, () => {
    it('reports exactly the bytes no member covers', () => {
      forEvery(({ label, model }) => {
        if (model.paddingBytes === null) return; // too large to scan; no claim made
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
        expect(actual, label).toEqual(expected);
        expect(model.paddingBytes, label).toBe(expected.length);
      });
    });

    it('emits runs that are non-empty, ascending, disjoint and in bounds', () => {
      forEvery(({ label, model }) => {
        let prevEnd = 0;
        for (const run of model.paddings) {
          expect(run.end, label).toBeGreaterThan(run.start);
          expect(run.start, label).toBeGreaterThanOrEqual(prevEnd);
          expect(run.end, label).toBeLessThanOrEqual(model.record.sizeBytes);
          prevEnd = run.end;
        }
        // Adjacent runs are merged, never left as two touching runs.
        for (let i = 1; i < model.paddings.length; i++) {
          expect(model.paddings[i]!.start, label).toBeGreaterThan(model.paddings[i - 1]!.end);
        }
      });
    });
  });

  describe(`${what}: extents`, () => {
    it('keeps every leaf inside the record it belongs to', () => {
      forEvery(({ label, model }) => {
        for (const leaf of model.leaves) {
          expect(leaf.offsetBits, `${label}: ${leaf.name}`).toBeGreaterThanOrEqual(0);
          expect(leaf.sizeBits, `${label}: ${leaf.name}`).toBeGreaterThanOrEqual(0);
          expect(
            leaf.offsetBits + leaf.sizeBits,
            `${label}: ${leaf.name} runs past sizeof`,
          ).toBeLessThanOrEqual(model.sizeBits);
        }
      });
    });

    it('gives every leaf a colour and every group real leaves', () => {
      forEvery(({ label, model }) => {
        for (const leaf of model.leaves) expect(leaf.colorClass, label).toBeTruthy();
        for (const g of model.groups) {
          expect(
            g.leafIndexes.every((li) => model.leaves[li] !== undefined),
            `${label}: ${g.name}`,
          ).toBe(true);
          // A member never occupies more than its own type.
          expect(g.sizeBits, `${label}: ${g.name}`).toBeLessThanOrEqual(g.typeSizeBits);
        }
      });
    });

    it('places every group over the leaves it claims', () => {
      forEvery(({ label, model }) => {
        for (const g of model.groups) {
          for (const li of g.leafIndexes) {
            const leaf = model.leaves[li]!;
            if (leaf.sizeBits === 0) continue; // a zero-size member sits at an edge
            expect(leaf.offsetBits, `${label}: ${g.name} ⊅ ${leaf.name}`).toBeGreaterThanOrEqual(
              g.offsetBits,
            );
            expect(
              leaf.offsetBits + leaf.sizeBits,
              `${label}: ${g.name} ⊅ ${leaf.name}`,
            ).toBeLessThanOrEqual(g.offsetBits + Math.max(g.sizeBits, g.typeSizeBits));
          }
        }
      });
    });
  });

  const rows = (model: RenderModel) => flattenVisible(model.tree, new Set()).map((r) => r.node);

  describe(`${what}: table and grid agree`, () => {
    it('a row lights up the grid exactly when it claims to occupy bytes', () => {
      forEvery(({ label, model }) => {
        for (const node of rows(model)) {
          const lit = litBytes(model, node);
          expect(
            lit.size > 0,
            `${label} / ${node.kind} ${node.ref}: size ${node.sizeBits} bits, ${lit.size} bytes lit`,
          ).toBe(node.sizeBits > 0);
        }
      });
    });

    it("never lights a byte outside the row's own extent", () => {
      forEvery(({ label, model }) => {
        for (const node of rows(model)) {
          // Every byte the row's own bit range touches: a 32-bit field
          // starting at bit 1 straddles five bytes, not four. Stated as the
          // set rather than the count: a row lighting the right *number* of
          // the wrong bytes is exactly the failure worth catching, and a
          // count cannot see it.
          const lo = Math.floor(node.offsetBits / 8);
          const hi = Math.ceil((node.offsetBits + node.sizeBits) / 8);
          const stray = [...litBytes(model, node)].filter((b) => b < lo || b >= hi);
          expect(
            stray,
            `${label} / ${node.kind} ${node.ref} lights bytes outside [${lo}, ${hi})`,
          ).toEqual([]);
        }
      });
    });
  });

  describe(`${what}: grid and table agree`, () => {
    it('hovering any drawn area highlights exactly the rows sharing it', () => {
      // The reverse of the block above: from the map back to the table.
      // Hovering a cell issues an area intent for exactly the extent drawn,
      // and every member with bits in that extent must light its row: at
      // least one for any occupied cell, and *all* of them where members
      // overlap, because a union byte belongs to each of its members at once
      // and the table is where they are told apart. A padding cell has no
      // row and must light none.
      forEvery(({ label, model }) => {
        for (const { fromBit, toBit } of drawnAreas(model)) {
          const hover = resolveHover({
            intent: { kind: 'area', record: KEY, fromBit, toBit, tooltip: null },
            mouse: null,
            cursor: null,
            preferCursor: false,
            models: new Map([[KEY, model]]),
            lines: new Map(),
            records: [],
            current: KEY,
          });
          // Independent recomputation: the members whose bits lie in the area.
          const occupying = model.leaves
            .flatMap((l, li) =>
              l.sizeBits > 0 && l.offsetBits < toBit && fromBit < l.offsetBits + l.sizeBits
                ? [li]
                : [],
            )
            .sort((a, b) => a - b);
          // The rows the table lights: it reads `hover.members`, keyed by leaf.
          const hovered = new Set(hover.members.filter((m) => m.record === KEY).map((m) => m.leaf));
          const lit = rows(model)
            .filter((n) => n.kind === 'leaf' && hovered.has(n.ref))
            .map((n) => n.ref)
            .sort((a, b) => a - b);
          expect(lit, `${label}: bits [${fromBit}, ${toBit})`).toEqual(occupying);
        }
      });
    });
  });

  describe(`${what}: the legend`, () => {
    /** A unit as `assignColors` means it: a *named* compound member of this record. */
    const units = (model: RenderModel) => model.groups.filter((g) => g.direct && !isTransparent(g));

    it('paints every leaf of a unit in the unit’s own colour', () => {
      // What `assignColors` is for: a colour identifies a *direct member*, so
      // `hdr` is one block in the grid rather than a stripe per nested field.
      // Vtable pointers are the deliberate exception: they are a category.
      forEvery(({ label, model }) => {
        for (const g of units(model)) {
          const colours = new Set(
            g.leafIndexes
              .map((li) => model.leaves[li]!.colorClass)
              .filter((c) => c !== SPECIAL_COLOR),
          );
          expect(colours.size, `${label}: ${g.name} spans ${[...colours].join(', ')}`).toBeLessThan(
            2,
          );
        }
      });
    });

    it('can name the colour of every unit it paints', () => {
      // The field table draws a chip from `groupColorClass` and the editor a
      // dot from the same rule; null means "no single colour stands for this",
      // which is true of an anonymous aggregate and of nothing else. It was
      // also true of every polymorphic base, because the vtable pointer inside
      // it counted as a second colour, so `B base` had no chip and no dot
      // while the grid painted its bytes blue.
      forEvery(({ label, model }) => {
        for (const g of units(model)) {
          if (g.leafIndexes.length === 0) continue; // an empty base paints nothing
          expect(groupColorClass(model, g), `${label}: ${g.name} has no colour to show`).not.toBe(
            null,
          );
        }
      });
    });

    /** The colours the table offers as chips, in row order. */
    const chipsOf = (model: RenderModel): string[] => {
      const chips: string[] = [];
      for (const node of rows(model)) {
        if (node.kind === 'leaf') {
          const leaf = model.leaves[node.ref]!;
          if (leaf.direct && leaf.colorClass !== SPECIAL_COLOR) {
            chips.push(leaf.colorClass!);
          }
        } else {
          const g = model.groups[node.ref]!;
          const c = g.direct ? groupColorClass(model, g) : null;
          if (c !== null && c !== SPECIAL_COLOR) chips.push(c);
        }
      }
      return chips;
    };

    it('names every colour the grid paints', () => {
      // The table is the grid's legend: a reader who sees a colour must be
      // able to find the row it belongs to, and the table must not offer a
      // colour that is nowhere in the picture.
      forEvery(({ label, model }) => {
        const painted = new Set(
          model.leaves.map((l) => l.colorClass).filter((c) => c && c !== SPECIAL_COLOR),
        );
        expect(
          [...new Set(chipsOf(model))].sort(),
          `${label}: chips do not cover the grid`,
        ).toEqual([...painted].sort());
      });
    });

    it('hands each member a colour of its own, as far as the palette reaches', () => {
      // "No two rows share a colour" is false as stated, which is how it was
      // written first: the palette has eight hues and a record with more
      // direct members than that reuses them, because a ninth nobody can tell
      // from the third is worse. The first attempt to salvage it guarded on
      // `directMembers().length <= PALETTE_SIZE` and still failed, on a union
      // whose slot count that helper does not agree with.
      //
      // So state what is actually true and leave the wrapping to arithmetic:
      // the allocation is injective. Run it again with a palette that cannot
      // wrap, and any repeat left is a real collision.
      forEvery(({ label, model }) => {
        const wide = structuredClone(model);
        assignColors(wide, 10_000);
        const chips = chipsOf(wide);
        expect(chips.length, `${label}: two members were given one colour`).toBe(
          new Set(chips).size,
        );
      });
    });

    it('gives a declarator introducing one member that member’s colour', () => {
      // The gutter dot. `c-compound` is the neutral ring, for a line whose
      // declarator genuinely stands for several colours; a line introducing a
      // single unit has a colour and must show it.
      forEvery(({ label, model }) => {
        const lines = buildLineIndex(new Map([[KEY, model]]));
        for (const info of lines.values()) {
          for (const mark of info.marks) {
            if (mark.items.length !== 1) continue;
            const it = mark.items[0]!;
            // A leaf always stands for itself; a group only when it is a unit
            // with leaves of its own.
            const single =
              !('leafIndexes' in it) ||
              (it.direct && !isTransparent(it) && it.leafIndexes.length > 0);
            if (!single) continue;
            expect(
              mark.colorClass,
              `${label}: line ${info.line} introduces ${it.name} with no colour`,
            ).not.toBe(COMPOUND);
          }
        }
      });
    });
  });

  describe(`${what}: containment tree`, () => {
    it('partitions the leaves: each appears exactly once', () => {
      forEvery(({ label, model }) => {
        const refs = allNodes(model.tree)
          .filter((n) => n.kind === 'leaf')
          .map((n) => n.ref)
          .sort((a, b) => a - b);
        expect(refs, label).toEqual(model.leaves.map((_, i) => i));
      });
    });

    it('nests groups: a subtree never escapes its parent', () => {
      forEvery(({ label, model }) => {
        const check = (nodes: TreeNode[], within: Set<number> | null): void => {
          for (const n of nodes) {
            if (within) {
              for (const li of n.leafIndexes) expect(within.has(li), label).toBe(true);
            }
            check(n.children, n.kind === 'group' ? new Set(n.leafIndexes) : null);
          }
        };
        check(model.tree, null);
      });
    });

    it('gives every node a unique id and a depth matching its nesting', () => {
      forEvery(({ label, model }) => {
        const ids = allNodes(model.tree).map((n) => n.id);
        // A duplicate id is not cosmetic: the field table keys its rows by it,
        // and a keyed `{#each}` rejects a repeat outright.
        expect(new Set(ids).size, `${label}: a node is rendered twice`).toBe(ids.length);
        const check = (nodes: TreeNode[], d: number): void => {
          for (const n of nodes) {
            expect(n.depth, label).toBe(d);
            check(n.children, d + 1);
          }
        };
        check(model.tree, 0);
      });
    });

    it('indents each group under exactly the members its path names', () => {
      // The tree is what the table renders, and `Group.path` is what the model
      // recorded as enclosing that member. If they disagree, the table shows a
      // subobject nested in something that does not contain it, which is what
      // happened when leafless groups were placed by nesting depth alone, and
      // two sibling members each adopted the other's base.
      forEvery(({ label, model }) => {
        const walk = (nodes: TreeNode[], ancestors: string[]): void => {
          for (const n of nodes) {
            if (n.kind !== 'group') {
              walk(n.children, ancestors);
              continue;
            }
            const g = model.groups[n.ref]!;
            // Sibling anonymous aggregates share one label, so a path through
            // one genuinely cannot say which; that ambiguity is in the source,
            // not in the tree. Named members carry no such excuse.
            const ambiguous = [...g.path, ...ancestors].includes(ANON_LABEL);
            if (!ambiguous) {
              expect(
                g.path,
                `${label}: ${g.name} is drawn inside [${ancestors.join(' :: ')}]`,
              ).toEqual(ancestors);
            }
            walk(n.children, [...ancestors, g.name]);
          }
        };
        walk(model.tree, []);
      });
    });

    it('orders siblings by where they start, where the language does', () => {
      forEvery(({ label, model, declarationIsStorageOrder = true }) => {
        if (!declarationIsStorageOrder) return;
        const walk = (nodes: TreeNode[]): void => {
          const offsets = nodes.map((n) => n.offsetBits);
          expect(offsets, `${label}: siblings out of order`).toEqual(
            [...offsets].sort((a, b) => a - b),
          );
          for (const n of nodes) walk(n.children);
        };
        walk(model.tree);
      });
    });

    it('hides exactly the descendants of collapsed nodes', () => {
      forEvery(({ label, model }) => {
        const nodes = allNodes(model.tree);
        // Expanded: every node, in depth-first order.
        expect(
          flattenVisible(model.tree, new Set()).map((r) => r.node.id),
          label,
        ).toEqual(nodes.map((n) => n.id));
        // Every collapsible node, not one sampled per record.
        for (const target of nodes.filter((n) => n.children.length > 0)) {
          const hidden = new Set(allNodes(target.children).map((n) => n.id));
          const shown = new Set(
            flattenVisible(model.tree, new Set([target.id])).map((r) => r.node.id),
          );
          expect(shown.has(target.id), label).toBe(true);
          for (const id of hidden) expect(shown.has(id), label).toBe(false);
          for (const n of nodes) {
            if (!hidden.has(n.id)) expect(shown.has(n.id), label).toBe(true);
          }
        }
      });
    });
  });
}
