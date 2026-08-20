# Working on ABI Explorer

## Setup

```sh
npm install
npm run abi:fetch    # the layout module (a pinned clang-abi-wasm release)
npm run dev          # Vite dev server
```

Other scripts:

```sh
npm test             # unit tests: recorded answers, plus the real module when present
npm run e2e          # Playwright against the production build
npm run check        # svelte-check + tsc (strict)
npm run lint         # eslint (strict, type-checked)
npm run fixtures     # re-record the corpus (tests/fixtures/responses)
```

If you change one of the shipped examples in `src/core/targets.ts`, run
`npm run fixtures` afterwards. The recorded corpus keeps its own copy of each
example's source, so without that step the tests keep checking the old text.

## Working on the module

To iterate on clang-abi-wasm itself, point the app at a local build. A rebuild
there shows up here on reload:

```sh
cd ../clang-abi-wasm && scripts/build.sh wasm && scripts/dev-link.sh ../abi-explorer-2
```

`npm run abi:fetch` leaves that symlink alone.

## Layout

```
src/core/          pure, unit-tested: render (wire to model, colours), types,
                   options, url-state, targets, themes, ansi
src/compiler/      abi.worker (the module in a Worker), AbiClient (protocol),
                   AbiAnalyzer (query to Analysis, caching, spelling probes)
src/state/         store (Svelte 5 runes), session (orchestration, hover, type
                   docs), code-locations (the editor's per-line index), theme
src/ui/            Svelte components, Monaco setup, dockview integration, themes
tests/unit/        vitest; tests/fixtures/responses holds the recorded corpus
tests/e2e/         Playwright against the production build
tools/             fetch-abi-module.mjs (pull a pinned module release),
                   stage-module.mjs (gzip and content-address it for the host)
public/vendor/abi  the layout module the site serves
```

`src/core` must stay free of browser globals and must not import from the other
layers. `tests/unit/architecture.test.ts` enforces both, along with a couple of
other rules that are easier to check than to remember.

## Tests

There are four kinds, and they exist for different reasons.

**Recorded.** `tests/fixtures/responses/` holds one real query response per
(example, target). Every model, tree, padding and line-index test runs off
those, so the suite needs no compiler and still checks real answers.

**Laws.** `tests/unit/model-laws.ts` states what has to be true of any render
model: padding is exactly the uncovered bytes, the tree partitions the leaves,
a table row lights the byte map if and only if it claims bytes, and so on. The
laws run twice, exhaustively over the corpus and over generated programs.

**Generated.** `properties.real.test.ts` emits random record declarations
(bit-fields straddling storage units, virtual bases, anonymous aggregates,
over-aligned members, packed structs), compiles them for real on three targets,
and checks the same laws. It generates _source_, not layouts. A generator that
invented layouts could only produce what its author already believed clang
does.

**Real.** `abi.real.test.ts` drives the shipped module end to end.

The `.real.` suites skip themselves when no module is present.

## Deployment

Cloudflare Pages via Git integration: build command `npm run build`, output
directory `dist`. The build fetches the pinned module first, because a site
built without it loads and then cannot answer anything. It keeps going on a
network failure only when the module is already there.

`tools/stage-module.mjs` then prepares `dist/vendor/abi/` for a static host. It
gzips the wasm and the header pack, which takes a first visit from 47 MB to
about 11 MB and gets the wasm under Cloudflare's 25 MiB per-asset limit. It
also names every file after its content.

Those names are the update path. The directory is served `immutable` and cached
`CacheFirst` by the service worker, so a new module published under an old name
is one no returning visitor would ever fetch. `manifest.json` is the single
mutable file: read network-first with the cached copy as the offline fallback,
and every loader resolves through it. The worker deletes cache entries the
current manifest does not name, so an upgrade also reclaims the previous
module's ~11 MB.

CI (`.github/workflows/ci.yml`) fetches the pinned clang-abi-wasm release, then
runs lint, type-check, the unit suites (including the ones that drive the real
module), the build and Playwright, all against the same copy of the module the
site serves.
