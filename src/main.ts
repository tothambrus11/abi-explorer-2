import { mount } from 'svelte';
import './styles/app.css';
import App from './App.svelte';
import { ClangClient } from '$compiler/ClangClient';
import ClangWorker from '$compiler/clang.worker?worker';
import AbiWorker from '$compiler/abi.worker?worker';
import { AbiClient } from '$compiler/AbiClient';
import { AbiAnalyzer } from '$compiler/AbiAnalyzer';
import { Session } from '$state/session.svelte';
import { store } from '$state/store.svelte';
import { setupPwa } from './pwa';

// Two pipelines, one switch. `VITE_ABI` selects the clang-abi-wasm module,
// which answers a layout query in one call instead of six compiles; without it
// the app runs the text-parsing driver exactly as before. The flag exists so
// the two can be compared on the same build rather than across a rewrite.
const useAbi = import.meta.env['VITE_ABI'] === '1';

const compiler = useAbi
  ? new AbiClient({ createWorker: () => new AbiWorker() })
  : new ClangClient({ createWorker: () => new ClangWorker() });
const session = new Session(
  compiler,
  compiler instanceof AbiClient ? new AbiAnalyzer(compiler) : undefined,
);
// Kick the (slow, DOM-independent) wasm load off before restoring state and
// mounting — but through the session, which first checks whether the download
// needs the user's consent. Starting the compiler directly here would fetch the
// 27 MB bundle behind the consent prompt (issue #1).
void session.boot();

await session.restoreFromUrl();
mount(App, { target: document.getElementById('app')!, props: { session } });
session.start();
setupPwa();

// Expose for e2e tests / debugging.
declare global {
  interface Window {
    __abix?: { store: typeof store; session: Session };
  }
}
window.__abix = { store, session };
