import { mount } from 'svelte';
import './styles/app.css';
import App from './App.svelte';
import AbiWorker from '$compiler/abi.worker?worker';
import HyloWorker from '$compiler/hylo.worker?worker';
import { AbiClient } from '$compiler/AbiClient';
import { Backends } from '$compiler/Backends';
import { Session } from '$state/session.svelte';
import { store } from '$state/store.svelte';
import type { Dock } from '$ui/dock';
import { setupPwa } from './pwa';

// One worker per backend, built on demand. `?worker` makes each its own chunk,
// so the bundle for a session that never selects Hylo does not carry its host.
const session = new Session(
  new Backends(
    (id) =>
      new AbiClient({
        createWorker: () => (id === 'hylo' ? new HyloWorker() : new AbiWorker()),
      }),
  ),
);
// Restore first: a shared link carries the language, and the language decides
// which compiler is about to be downloaded. Booting before reading it would
// start clang for a link that asked for Hylo, and 11 MB would cross the
// connection for a module the visitor never uses. Decoding a fragment is
// cheap; the module load is what is slow, and it starts immediately after.
await session.restoreFromUrl();

// Kick the (slow, DOM-independent) wasm load off before mounting, but through
// the session, which first checks whether the download needs the user's
// consent. Starting the module directly here would fetch the bundle behind the
// consent prompt (issue #1).
void session.boot();

mount(App, { target: document.getElementById('app')!, props: { session } });
session.start();
setupPwa();

// Expose for e2e tests / debugging.
declare global {
  interface Window {
    __abix?: { store: typeof store; session: Session; dock?: Dock };
  }
}
window.__abix = { store, session };
