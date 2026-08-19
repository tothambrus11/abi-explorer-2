// Not a test: captures real `-fdump-record-layouts-complete` output for every
// corpus source, so the property tests can run against shapes clang actually
// emits without needing clang themselves. Run with `npm run fixtures`
// (ABIX_CAPTURE=1); skipped otherwise.
//
// Only the layout dump is stored, not a full analyzer recording — these files
// exist to be *parsed*, not replayed, so they stay small and readable.

import { it } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { buildArgv, DEFAULT_OPTIONS, defaultStdFor, driverFor, sourceExtension } from '$core/options';
import type { Compiler } from '$compiler/Compiler';
import { corpusSources, LAYOUTS_DIR, layoutFile } from './corpus';

it.skipIf(process.env['ABIX_CAPTURE'] !== '1')(
  'captures layout dumps for the corpus',
  async () => {
    const { createNodeCompiler } = await import('../../tools/node-clang.mjs');
    const clang = (await createNodeCompiler()) as Compiler;
    await mkdir(LAYOUTS_DIR, { recursive: true });

    for (const src of corpusSources()) {
      for (const triple of src.triples) {
        const options = {
          ...DEFAULT_OPTIONS,
          lang: src.lang,
          std: defaultStdFor(src.lang),
          triple,
        };
        const file = 'input.' + sourceExtension(src.lang);
        const out = await clang.compile({
          argv0: driverFor(src.lang),
          args: buildArgv(options, { kind: 'layout', files: [file] }),
          files: { [file]: src.source },
        });
        // Errors are worth knowing about, but a partial dump is still a corpus
        // entry: the parser has to cope with whatever clang managed to print.
        if (out.code !== 0) {
          console.warn(`${src.name}--${triple}: clang exited ${out.code}\n${out.stderr}`);
        }
        await writeFile(layoutFile(src.name, triple), out.stdout);
      }
    }
  },
  900_000,
);
