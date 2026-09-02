// Service-worker registration (vite-plugin-pwa injectManifest build) and the
// "available offline" signal.
import { registerSW } from 'virtual:pwa-register';
import { store } from '$state/store.svelte';

/**
 * Registers the service worker, and keeps the store's offline flags true.
 *
 * Does nothing where service workers are unavailable, which includes a private
 * window and any insecure origin, so the app must work without this being
 * called. Safe to call once at start-up and nowhere else.
 */
export function setupPwa(): void {
  if (!('serviceWorker' in navigator)) return;
  registerSW({
    immediate: true,
    // registerType is 'autoUpdate': the new SW activates on its own and the
    // plugin would reload the page immediately unless onNeedReload is given.
    // Surface it in the footer instead so an edit in progress isn't lost.
    onNeedReload() {
      store.swVersionAvailable = true;
    },
    onOfflineReady() {
      updateControlled();
    },
    onRegisteredSW() {
      updateControlled();
    },
  });
  navigator.serviceWorker.ready.then(updateControlled).catch(() => {});
  // clientsClaim() hands the page to the new worker after `ready` resolves.
  navigator.serviceWorker.addEventListener('controllerchange', updateControlled);
}

/** Notes whether a worker is now serving this page, which is what "offline" means here. */
function updateControlled(): void {
  store.swControlled = !!navigator.serviceWorker.controller;
}
