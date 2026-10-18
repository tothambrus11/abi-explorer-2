// A copy of test/fixtures/project in a temporary directory, with its
// compile_commands.json written for wherever the copy landed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'project');

export interface FixtureProject {
  root: string;
  path(relative: string): string;
  uri(relative: string): string;
  remove(): void;
}

export function copyFixtureProject(): FixtureProject {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abi-explorer-')));
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.mkdirSync(path.join(root, 'build'));
  const template = fs.readFileSync(path.join(root, 'compile_commands.template.json'), 'utf8');
  fs.writeFileSync(
    path.join(root, 'build', 'compile_commands.json'),
    template.replaceAll('${root}', root),
  );
  fs.rmSync(path.join(root, 'compile_commands.template.json'));
  return {
    root,
    path: (relative) => path.join(root, relative),
    uri: (relative) => new URL(`file://${path.join(root, relative)}`).href,
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** The engine files the web app fetches with `npm run abi:fetch`; tests that need them skip without. */
export const LOCAL_ENGINE =
  process.env['ABI_ENGINE_PATH'] ??
  path.join(import.meta.dirname, '..', '..', '..', '..', 'public', 'vendor', 'abi');
export const hasLocalEngine = fs.existsSync(path.join(LOCAL_ENGINE, 'abi_query.wasm'));
