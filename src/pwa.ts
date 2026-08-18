// Service-worker registration (vite-plugin-pwa injectManifest build) and the
// "available offline" signal.
import { registerSW } from 'virtual:pwa-register';
import { store } from '$state/store.svelte';

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

function updateControlled(): void {
  store.swControlled = !!navigator.serviceWorker.controller;
}
