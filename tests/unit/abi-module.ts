// The real module, loaded once for the whole run.
//
// Tests that need clang go through here. Everything else runs off the captured
// responses in tests/fixtures/responses: the same data, recorded.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fromSyncModule, type AbiModule } from '$compiler/AbiAnalyzer';

/**
 * The same copy the app serves: a symlink to a local build during development
 * (clang-abi-wasm's dev-link.sh), a fetched release in CI (`npm run abi:fetch`).
 * Testing against a different copy than the one that ships would only prove the
 * two agree.
 */
export const DIST =
  process.env['ABI_WASM_DIST'] ?? path.join(process.cwd(), 'public', 'vendor', 'abi');

/** Is a built module available? Real-clang suites skip themselves when not. */
export const moduleAvailable = existsSync(path.join(DIST, 'abi_query.mjs'));

let pending: Promise<AbiModule> | null = null;

/** Load the module (about a second) and keep it: every caller shares one. */
export function abiModule(): Promise<AbiModule> {
  pending ??= (async () => {
    const { load } = (await import(/* @vite-ignore */ path.join(DIST, 'index.mjs'))) as {
      load: (o: { baseUrl: string }) => Promise<Parameters<typeof fromSyncModule>[0]>;
    };
    return fromSyncModule(await load({ baseUrl: DIST }));
  })();
  return pending;
}
