// code-server with the packaged extension installed, on a copy of the fixture
// project: VS Code in a browser, so Playwright can drive it.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENGINE_RELEASE } from 'abi-explorer-lsp/engineFiles';

export interface CodeServer {
  url: string;
  stop(): void;
}

export interface CodeServerOptions {
  /** The code-server entry script (`…/code-server/out/node/entry.js`). */
  entry: string;
  vsix: string;
  workspace: string;
  /** Engine files to seed the extension's cache with, so nothing is downloaded. */
  engineDirectory: string;
  settings: Record<string, unknown>;
  port: number;
}

export async function startCodeServer(options: CodeServerOptions): Promise<CodeServer> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-code-server-'));
  const userData = path.join(home, 'user-data');
  const extensions = path.join(home, 'extensions');
  const run = (args: string[]) =>
    execFileSync(process.execPath, [options.entry, '--user-data-dir', userData, '--extensions-dir', extensions, ...args], {
      stdio: 'pipe',
    });
  run(['--install-extension', options.vsix]);

  const cache = path.join(userData, 'User', 'globalStorage', 'tothambrus11.abi-explorer', `clang-abi-wasm-${ENGINE_RELEASE.tag}`);
  fs.mkdirSync(cache, { recursive: true });
  for (const file of ENGINE_RELEASE.files) fs.copyFileSync(path.join(options.engineDirectory, file.name), path.join(cache, file.name));
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify(options.settings, null, 2));

  const server: ChildProcess = spawn(
    process.execPath,
    [
      options.entry,
      '--user-data-dir', userData,
      '--extensions-dir', extensions,
      '--auth', 'none',
      '--bind-addr', `127.0.0.1:${options.port}`,
      '--disable-telemetry',
      '--disable-update-check',
      '--disable-workspace-trust',
      options.workspace,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolve, reject) => {
    const onData = (data: Buffer) => {
      if (data.toString().includes('HTTP server listening')) resolve();
    };
    server.stdout!.on('data', onData);
    server.stderr!.on('data', onData);
    server.on('exit', (code) => reject(new Error(`code-server exited with ${code}`)));
  });
  return {
    url: `http://127.0.0.1:${options.port}/?folder=${encodeURIComponent(options.workspace)}`,
    stop() {
      server.kill();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
