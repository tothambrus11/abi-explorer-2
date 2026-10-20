// Entry point: `abi-explorer-lsp --stdio`.
//
// Runs from the bundle in `dist/` when installed, and straight from source
// (Node strips the types) during development and in the integration tests.

import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { startServer } from './server.ts';

const fromSource = import.meta.url.endsWith('.ts');
startServer(createConnection(ProposedFeatures.all), {
  engineWorker: new URL(
    fromSource ? './engine/engineWorker.ts' : './engineWorker.js',
    import.meta.url,
  ),
});
