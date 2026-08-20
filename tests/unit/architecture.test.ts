// The dependency direction, as an executable rule rather than a convention.
//
//   core      pure domain logic: the render model, options, themes. Depends on
//             nothing of ours, and must stay runnable without a DOM.
//   compiler  talks to the wasm module (worker client, analysis pipeline).
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

  // The module download must not start before the metered-connection gate has
  // had its say (issue #1). The gate lives in `Session.boot()`, so a second
  // caller starting the client makes it decorative — which is exactly what an
  // eager `start()` in `main.ts` used to do, with the consent prompt rendering
  // over a download already in flight.
  it('starts the module only through the session, which owns the download gate', () => {
    const START = /\b(?:client|compiler|module)\.start\s*\(/;
    const offenders: string[] = [];
    for (const layer of Object.keys(MAY_IMPORT) as Layer[]) {
      for (const file of filesIn(path.join(SRC, layer))) {
        const rel = path.relative(SRC, file);
        if (rel === path.join('state', 'session.svelte.ts')) continue;
        if (START.test(code(readFileSync(file, 'utf8')))) offenders.push(rel);
      }
    }
    if (START.test(code(readFileSync(path.join(SRC, 'main.ts'), 'utf8')))) {
      offenders.push('main.ts');
    }
    expect(offenders).toEqual([]);
  });

  // The module directory is served immutable because every file in it is named
  // after its content — every file but one. `manifest.json` is what says what
  // those names currently are, so it is the only route to a new module, and a
  // header telling the world to keep it for a year closes that route: the fix
  // for stale modules would itself be cached, and returning visitors would
  // find out about a release up to a year late. It matched `/vendor/*` and got
  // exactly that header until this test existed.
  it('the module manifest is not served immutable, unlike everything beside it', () => {
    const rules = readFileSync(path.join(process.cwd(), 'public', '_headers'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'));

    // Every rule that matches contributes: Cloudflare Pages *merges* the
    // values rather than letting the last one win, which is how an exception
    // carved out of a broader rule became `immutable, no-cache` in production
    // — asking for both and settling nothing.
    const cacheControl = (target: string): string => {
      const values: string[] = [];
      let matching = false;
      for (const line of rules) {
        if (!line.startsWith(' ') && line.trim() !== '') {
          const pattern = line.trim();
          matching = pattern.endsWith('*')
            ? target.startsWith(pattern.slice(0, -1))
            : pattern === target;
          continue;
        }
        const [name, ...rest] = line.trim().split(':');
        if (matching && name?.toLowerCase() === 'cache-control') values.push(rest.join(':').trim());
      }
      return values.join(', ');
    };

    expect(cacheControl('/vendor/abi/abi_query-1f3ff79bf58c.wasm.gz')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(cacheControl('/vendor/abi/manifest.json')).toBe('no-cache');
  });

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
