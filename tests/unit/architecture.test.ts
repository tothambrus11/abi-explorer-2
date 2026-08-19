// The dependency direction, as an executable rule rather than a convention.
//
//   core      pure domain logic: layouts, probes, parsing, themes. Depends on
//             nothing of ours, and must stay runnable without a DOM.
//   compiler  drives clang (worker protocol, client, analysis pipeline).
//   state     reactive orchestration; may use core and compiler.
//   ui        components; may use everything.
//
// Anything pointing the other way means logic has drifted into a layer that
// cannot be tested — which is exactly how `themes.ts` ended up in `ui` while
// `state` depended on it.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');
type Layer = 'core' | 'compiler' | 'state' | 'ui';

/** What each layer is allowed to import from. */
const MAY_IMPORT: Record<Layer, Layer[]> = {
  core: [],
  compiler: ['core'],
  state: ['core', 'compiler'],
  ui: ['core', 'compiler', 'state'],
};

function filesIn(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesIn(full));
    else if (/\.(ts|svelte)$/.test(name)) out.push(full);
  }
  return out;
}

/** Source with comments removed, so prose about `navigator` is not a usage. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Aliased imports (`$core/...`) used by a file. */
function aliasImports(source: string): Layer[] {
  return [...source.matchAll(/from\s+'\$(core|compiler|state|ui)\//g)].map((m) => m[1] as Layer);
}

describe('architecture', () => {
  for (const layer of Object.keys(MAY_IMPORT) as Layer[]) {
    it(`${layer} only imports ${MAY_IMPORT[layer].join(', ') || 'nothing of ours'}`, () => {
      const allowed = new Set<Layer>([layer, ...MAY_IMPORT[layer]]);
      const offenders: string[] = [];
      for (const file of filesIn(path.join(SRC, layer))) {
        for (const target of aliasImports(readFileSync(file, 'utf8'))) {
          if (!allowed.has(target)) {
            offenders.push(`${path.relative(SRC, file)} → $${target}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('core stays free of browser globals so it runs anywhere', () => {
    const offenders: string[] = [];
    for (const file of filesIn(path.join(SRC, 'core'))) {
      const src = code(readFileSync(file, 'utf8'));
      // `document`/`window`/`localStorage` reached from pure domain code would
      // make it untestable in node and unusable in the worker.
      for (const g of ['document.', 'window.', 'localStorage.', 'navigator.']) {
        if (src.includes(g)) offenders.push(`${path.relative(SRC, file)} uses ${g}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
