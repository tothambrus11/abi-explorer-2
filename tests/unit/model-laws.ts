// What must be true of every render model, whatever produced it.
//
// These are shared so the same laws run twice: exhaustively over the captured
// corpus (`properties.test.ts`), and over generated sources compiled for real
// (`properties.real.test.ts`). A law stated once cannot drift between the two,
// and a failure names the record either way.

import { describe, it, expect } from 'vitest';
import { flattenVisible } from '$core/render';
import type { RenderModel, TreeNode } from '$core/types';

export interface Subject {
  /** Where this model came from, so a failure names it. */
  label: string;
  model: RenderModel;
}

/** How the model labels a member with no name of its own. */
const ANON_LABEL = '(anonymous)';

const allNodes = (nodes: TreeNode[]): TreeNode[] =>
  nodes.flatMap((n) => [n, ...allNodes(n.children)]);

/**
 * What hovering a table row paints in the byte grid: `ByteGrid` lights a byte
 * when any leaf covering it is in `store.hover.members`, and a row contributes
 * exactly its own leaves (`resolveIntent` in `$state/hover`).
 */
function highlightedBytes(model: RenderModel, node: TreeNode): number {
  const size = model.record.sizeBytes;
  const bytes = new Set<number>();
  for (const li of node.leafIndexes) {
    const leaf = model.leaves[li];
    if (!leaf) continue;
    const from = Math.max(0, Math.floor(leaf.offsetBits / 8));
    const to = Math.min(size, Math.ceil((leaf.offsetBits + leaf.sizeBits) / 8));
    for (let b = from; b < to; b++) bytes.add(b);
  }
  return bytes.size;
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

  describe(`${what}: table and grid agree`, () => {
    const rows = (model: RenderModel) => flattenVisible(model.tree, new Set()).map((r) => r.node);

    it('a row lights up the grid exactly when it claims to occupy bytes', () => {
      forEvery(({ label, model }) => {
        for (const node of rows(model)) {
          const lit = highlightedBytes(model, node);
          expect(
            lit > 0,
            `${label} / ${node.kind} ${node.ref}: size ${node.sizeBits} bits, ${lit} bytes lit`,
          ).toBe(node.sizeBits > 0);
        }
      });
    });

    it("never lights a byte outside the row's own extent", () => {
      forEvery(({ label, model }) => {
        for (const node of rows(model)) {
          const lit = highlightedBytes(model, node);
          // Bytes the row's own bit range touches — a 32-bit field starting at
          // bit 1 straddles five bytes, not four.
          const extent =
            Math.ceil((node.offsetBits + node.sizeBits) / 8) - Math.floor(node.offsetBits / 8);
          // Padding inside a compound member is covered by no leaf, so the lit
          // count is a subset of the extent — never more than it.
          expect(lit, `${label} / ${node.kind} ${node.ref}`).toBeLessThanOrEqual(extent);
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
      // subobject nested in something that does not contain it — which is what
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
            // one genuinely cannot say which — that ambiguity is in the source,
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

    it('orders siblings by where they start', () => {
      forEvery(({ label, model }) => {
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
