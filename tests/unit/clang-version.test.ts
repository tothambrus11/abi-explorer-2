// The pinned clang version appears in five places that no build step ties
// together: the app, the Node test harness, the vendoring script, the CI cache
// key and the vendored NOTICE. A bump that misses one of them is silent —
// stale CI caches, or a vendor script fetching a different build than the app
// expects — so the agreement is asserted here instead of hoped for.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CLANG_VERSION } from '$compiler/clang-assets';

const ROOT = process.cwd();

/** Files that must name the same clang version, and how it is written there. */
const SITES: { file: string; quote: (v: string) => string }[] = [
  { file: 'tools/node-clang.mjs', quote: (v) => `CLANG_VERSION = '${v}'` },
  { file: 'tools/vendor-clang.sh', quote: (v) => `VERSION="${v}"` },
  { file: '.github/workflows/ci.yml', quote: (v) => `yowasp-clang-${v}` },
  { file: 'public/vendor/clang/NOTICE.md', quote: (v) => `\`${v}\`` },
];

describe('pinned clang version', () => {
  it('is a concrete @yowasp/clang release', () => {
    expect(CLANG_VERSION).toMatch(/^\d+\.\d+\.\d+-\S+$/);
  });

  for (const site of SITES) {
    it(`matches ${site.file}`, () => {
      const text = readFileSync(path.join(ROOT, site.file), 'utf8');
      expect(text, `${site.file} does not pin ${CLANG_VERSION}`).toContain(site.quote(CLANG_VERSION));
    });
  }
});
