#!/usr/bin/env node
// The editors are released together, under one version, kept in five files.
//
//   node scripts/version.mjs              prints it, failing if the files disagree
//   node scripts/version.mjs check 0.2.0  fails unless every file says 0.2.0
//   node scripts/version.mjs set 0.2.0    writes 0.2.0 into every file
//
// The release workflow runs `check` with the version from its tag
// (`editors-v0.2.0`), so a tag that does not match the files publishes nothing.

import fs from 'node:fs';
import path from 'node:path';

const editors = path.resolve(import.meta.dirname, '..');

/** Each file's version, read and written by a pattern whose first group is the version. */
const FILES = [
  { file: 'server/package.json', pattern: /^ {2}"version": "([^"]+)"/m },
  { file: 'vscode/package.json', pattern: /^ {2}"version": "([^"]+)"/m },
  { file: 'clion/gradle.properties', pattern: /^pluginVersion = (\S+)$/m },
  { file: 'zed/extension.toml', pattern: /^version = "([^"]+)"$/m },
  { file: 'zed/Cargo.toml', pattern: /^version = "([^"]+)"$/m },
];

function read() {
  return FILES.map(({ file, pattern }) => {
    const match = pattern.exec(fs.readFileSync(path.join(editors, file), 'utf8'));
    if (!match) throw new Error(`no version in ${file}`);
    return { file, version: match[1] };
  });
}

function agreed(versions) {
  const distinct = new Set(versions.map((entry) => entry.version));
  if (distinct.size !== 1) {
    for (const entry of versions) console.error(`${entry.version}  ${entry.file}`);
    throw new Error('the editors disagree about their version');
  }
  return versions[0].version;
}

const [command, wanted] = process.argv.slice(2);
try {
  if (!command) {
    console.log(agreed(read()));
  } else if (command === 'check' && wanted) {
    const version = agreed(read());
    if (version !== wanted) throw new Error(`the editors are at ${version}, not ${wanted}`);
    console.log(version);
  } else if (command === 'set' && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(wanted ?? '')) {
    for (const { file, pattern } of FILES) {
      const full = path.join(editors, file);
      const text = fs.readFileSync(full, 'utf8');
      fs.writeFileSync(
        full,
        text.replace(pattern, (line, old) => line.replace(old, wanted)),
      );
    }
    // The lock files name the packages' versions too. Edited in place rather
    // than by npm, which would rewrite whatever its own version writes differently.
    const npmLock = path.join(editors, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(npmLock, 'utf8'));
    for (const workspace of ['server', 'vscode']) lock.packages[workspace].version = wanted;
    fs.writeFileSync(npmLock, JSON.stringify(lock, null, 2) + '\n');
    const cargoLock = path.join(editors, 'zed', 'Cargo.lock');
    fs.writeFileSync(
      cargoLock,
      fs
        .readFileSync(cargoLock, 'utf8')
        .replace(/(name = "zed_abi_explorer"\nversion = ")[^"]+"/, `$1${wanted}"`),
    );
    console.log(agreed(read()));
  } else {
    console.error('usage: version.mjs [check <version> | set <version>]');
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
