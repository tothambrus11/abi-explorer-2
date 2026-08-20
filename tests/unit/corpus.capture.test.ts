// Not a test: records the module's answer for every corpus source, so the rest
// of the suite runs against shapes clang actually produces without needing
// clang itself. Run with `npm run fixtures` (ABIX_CAPTURE=1); skipped otherwise.
//
// The whole response is stored, not a summary: these files stand in for the
// compiler, and a test that reads one is reading exactly what the app would.

import { it, expect } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { corpusSources, optionsFor, responseFile, RESPONSES_DIR } from './corpus';
import { abiModule, moduleAvailable } from './abi-module';

it.skipIf(process.env['ABIX_CAPTURE'] !== '1')(
  'captures a query response for every corpus source',
  async () => {
    expect(moduleAvailable, `no module at ABI_WASM_DIST: build it first`).toBe(true);
    const abi = await abiModule();
    await mkdir(RESPONSES_DIR, { recursive: true });

    for (const src of corpusSources()) {
      for (const triple of src.triples) {
        const options = optionsFor(src, triple);
        const response = await abi.query({
          source: src.source,
          triple,
          lang: options.lang === 'c++' ? 'c++' : 'c',
          std: options.std,
        });
        // Errors are worth knowing about, but a partial answer is still a
        // corpus entry: the app has to cope with whatever clang managed.
        if (response.exitCode !== 0) {
          console.warn(`${src.name}--${triple}: exit ${response.exitCode}`);
        }
        await writeFile(
          responseFile(src.name, triple),
          JSON.stringify({ source: src.source, options, response }, null, 1) + '\n',
        );
      }
    }
  },
  900_000,
);
