import { mount } from 'svelte';
import './styles/app.css';
import App from './App.svelte';
import { ClangClient } from '$compiler/ClangClient';
import ClangWorker from '$compiler/clang.worker?worker';
import { Session } from '$state/session.svelte';
import { store } from '$state/store.svelte';
import { setupPwa } from './pwa';

const compiler = new ClangClient({ createWorker: () => new ClangWorker() });
const session = new Session(compiler);
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
