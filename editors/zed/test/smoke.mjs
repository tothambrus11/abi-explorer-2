#!/usr/bin/env node
// The Zed extension in real Zed, end to end: the built extension.wasm installed
// into a throwaway HOME, Zed started on the fixture project under Xvfb, and the
// language server it starts recorded (scripts/lsp-recorder.mjs), so the checks
// read what Zed actually asked and what it was told.
//
//   ZED=…/zed.app/bin/zed node zed/test/smoke.mjs
//
// Environment:
//   ZED          the `zed` CLI (required)
//   SERVER       the server's entry script; default server/bin/abi-explorer-lsp.js
//                (the smoke job points it at the npm package as it will be published)
//   EXTENSION    an installed extension's directory (extension.toml, extension.wasm),
//                as the release's zip unpacks; default zed/extension.toml and WASM
//   WASM         extension.wasm; default the cargo release build in zed/target
//   ABI_ENGINE_PATH  engine files to use instead of downloading the pinned release
//   OUT          where a screenshot and the trace go when a check fails; default zed/test/out
//
// Needs Xvfb and xdotool, and ImageMagick's `import` for the failure screenshot.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyFixtureProject } from '../../server/test/support/fixtureProject.ts';

const editors = path.resolve(import.meta.dirname, '..', '..');
const zed = required('ZED');
const serverScript = path.resolve(
  process.env.SERVER ?? path.join(editors, 'server', 'bin', 'abi-explorer-lsp.js'),
);
const wasm = path.resolve(
  process.env.WASM ??
    path.join(editors, 'zed', 'target', 'wasm32-wasip2', 'release', 'zed_abi_explorer.wasm'),
);
const out = path.resolve(process.env.OUT ?? path.join(editors, 'zed', 'test', 'out'));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-zed-smoke-'));
const home = path.join(work, 'home');
const trace = path.join(work, 'trace.jsonl');
const display = `:${process.env.DISPLAY_NUMBER ?? 97}`;
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  DISPLAY: display,
  ZED_ALLOW_ROOT: 'true',
  ZED_ALLOW_EMULATED_GPU: '1',
};
for (const tool of ['Xvfb', 'xdotool']) {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' });
  } catch {
    console.error(`${tool} is not installed`);
    process.exit(2);
  }
}
// The server as `npm install -g` leaves it, an `abi-explorer-lsp` on PATH, which
// the extension prefers to downloading the npm package; recorded on the way.
const bin = path.join(work, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, 'abi-explorer-lsp'),
  `#!/bin/sh\nexec ${[
    process.execPath,
    path.join(editors, 'scripts', 'lsp-recorder.mjs'),
    trace,
    process.execPath,
    serverScript,
  ]
    .map((arg) => `'${arg}'`)
    .join(' ')} "$@"\n`,
  { mode: 0o755 },
);
env.PATH = `${bin}${path.delimiter}${env.PATH}`;
const project = copyFixtureProject();
const children = [];

try {
  install();
  children.push(spawn('Xvfb', [display, '-screen', '0', '1400x900x24'], { stdio: 'ignore' }));
  await sleep(1000);
  // `path:line:column` puts the caret on `Packet`, so the hover and code
  // actions below need no mouse.
  const zedLog = fs.openSync(path.join(work, 'zed.log'), 'w');
  children.push(
    spawn(zed, ['--foreground', project.root, `${project.path('main.cpp')}:9:10`], {
      env,
      cwd: project.root,
      stdio: ['ignore', zedLog, zedLog],
    }),
  );

  // Zed asks whether to trust a project it has not seen, and starts no
  // language server until it is; Return accepts.
  const initialize = await waitFor(
    'Zed to start the server',
    180,
    (messages) => messages.find((m) => m.from === 'editor' && m.message.method === 'initialize'),
    () => key('Return'),
  );
  check(
    initialize.message.params.initializationOptions?.hoverImages === true,
    'the extension passes hoverImages: true (its language_server_initialization_options ran)',
  );

  await waitFor('the wasted-space warning on Packet', 180, (messages) =>
    messages.find(
      (m) =>
        m.message.method === 'textDocument/publishDiagnostics' &&
        m.message.params.uri.endsWith('/main.cpp') &&
        m.message.params.diagnostics.some((d) => d.code === 'reorder'),
    ),
  );

  // editor::Hover, then editor::ToggleCodeActions, at the caret.
  const hover = await waitFor(
    'a hover on Packet',
    60,
    (messages) =>
      responseTo(messages, 'textDocument/hover', (result) =>
        JSON.stringify(result ?? '').includes('struct Packet'),
      ),
    () => key('ctrl+k', 'ctrl+i'),
  );
  check(
    JSON.stringify(hover).includes('data:image/svg+xml'),
    'the hover carries the SVG byte map Zed renders',
  );

  const actions = await waitFor(
    'the code actions on Packet',
    60,
    (messages) =>
      responseTo(messages, 'textDocument/codeAction', (result) =>
        (result ?? []).some((action) => action.title?.startsWith('Reorder members')),
      ),
    // Zed asks for code actions when the caret moves, so it moves off and back.
    () => key('Escape', 'Down', 'Up', 'ctrl+period'),
  );
  console.log(`code actions: ${actions.map((action) => action.title).join(' | ')}`);
  console.log('Zed smoke test passed');
} catch (error) {
  fs.mkdirSync(out, { recursive: true });
  try {
    execFileSync('import', ['-window', 'root', path.join(out, 'zed-failure.png')], { env });
  } catch {
    // No ImageMagick: the trace and log still say what happened.
  }
  for (const file of ['trace.jsonl', 'zed.log']) {
    if (fs.existsSync(path.join(work, file))) {
      fs.copyFileSync(path.join(work, file), path.join(out, file));
    }
  }
  console.error(error instanceof Error ? error.message : error);
  console.error(`trace, log and screenshot in ${out}`);
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) child.kill();
  // Zed's CLI hands the window to a separate zed-editor process.
  try {
    execFileSync('pkill', ['-x', 'zed-editor']);
  } catch {
    // Not running.
  }
  project.remove();
  fs.rmSync(work, { recursive: true, force: true });
}

function install() {
  const packaged = process.env.EXTENSION && path.resolve(process.env.EXTENSION);
  if (!packaged && !fs.existsSync(wasm)) {
    throw new Error(`${wasm} is missing: cargo build --release --target wasm32-wasip2 in zed/`);
  }
  const extension = path.join(
    home,
    '.local',
    'share',
    'zed',
    'extensions',
    'installed',
    'abi-explorer',
  );
  if (packaged) {
    fs.cpSync(packaged, extension, { recursive: true });
  } else {
    fs.mkdirSync(extension, { recursive: true });
    fs.copyFileSync(
      path.join(editors, 'zed', 'extension.toml'),
      path.join(extension, 'extension.toml'),
    );
    fs.copyFileSync(wasm, path.join(extension, 'extension.wasm'));
  }
  const initializationOptions = process.env.ABI_ENGINE_PATH
    ? { enginePath: path.resolve(process.env.ABI_ENGINE_PATH) }
    : {};
  const settings = {
    auto_update: false,
    disable_ai: true,
    telemetry: { diagnostics: false, metrics: false },
    // Only this server, so nothing else is downloaded and every hover is ours.
    languages: {
      'C++': { language_servers: ['abi-explorer-lsp'] },
      C: { language_servers: ['abi-explorer-lsp'] },
    },
    lsp: { 'abi-explorer-lsp': { initialization_options: initializationOptions } },
  };
  fs.mkdirSync(path.join(home, '.config', 'zed'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config', 'zed', 'settings.json'),
    JSON.stringify(settings, null, 2),
  );
}

function messages() {
  if (!fs.existsSync(trace)) return [];
  return fs
    .readFileSync(trace, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The result of the latest request of `method` whose result passes `accept`. */
function responseTo(all, method, accept) {
  const ids = new Set(
    all.filter((m) => m.from === 'editor' && m.message.method === method).map((m) => m.message.id),
  );
  const reply = all.findLast(
    (m) =>
      m.from === 'server' &&
      ids.has(m.message.id) &&
      'result' in m.message &&
      accept(m.message.result),
  );
  return reply?.message.result;
}

/** Polls the trace until `found` returns something, nudging Zed with `poke` every few seconds. */
async function waitFor(what, seconds, found, poke = () => {}) {
  const deadline = Date.now() + seconds * 1000;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const result = found(messages());
    if (result) return result;
    if (attempt % 5 === 4) poke();
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function key(...keys) {
  try {
    // With no window manager, keyboard focus follows the pointer.
    execFileSync('xdotool', ['mousemove', '700', '450'], { env });
    execFileSync('xdotool', ['key', '--delay', '200', ...keys], { env });
  } catch {
    // No window yet.
  }
}

function check(condition, what) {
  if (!condition) throw new Error(`failed: ${what}`);
  console.log(`ok: ${what}`);
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`set ${name}`);
    process.exit(2);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
