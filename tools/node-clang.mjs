// Node-side Compiler backed by the YoWASP clang bundle (used by tests/tools).
// Downloads @yowasp/clang once into .cache/yowasp/ (gitignored).
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const CLANG_VERSION = '22.0.0-git20542-10';
const ROOT = new URL('..', import.meta.url).pathname;
const CACHE = path.join(ROOT, '.cache', 'yowasp');

export async function ensureYowasp() {
  const bundle = path.join(CACHE, 'package', 'gen', 'bundle.js');
  try {
    await stat(bundle);
    return bundle;
  } catch {
    /* download */
  }
  await mkdir(CACHE, { recursive: true });
  const url = `https://registry.npmjs.org/@yowasp/clang/-/clang-${CLANG_VERSION}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const tgz = path.join(CACHE, 'clang.tgz');
  await writeFile(tgz, Buffer.from(await res.arrayBuffer()));
  const r = spawnSync('tar', ['xzf', tgz, '-C', CACHE], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar failed');
  return bundle;
}

/** Returns a Compiler (see src/compiler/Compiler.ts) running clang in-process. */
export async function createNodeCompiler() {
  const bundle = await ensureYowasp();
  const { runClang, Exit } = await import(bundle);
  let chain = Promise.resolve();
  const compileOne = async ({ argv0, args, files }) => {
    const outDec = new TextDecoder();
    const errDec = new TextDecoder();
    let stdout = '',
      stderr = '',
      code = 0;
    try {
      await runClang([argv0, ...args], files, {
        stdout: (b) => {
          if (b) stdout += outDec.decode(b, { stream: true });
        },
        stderr: (b) => {
          if (b) stderr += errDec.decode(b, { stream: true });
        },
        fetchProgress: () => {},
      });
    } catch (e) {
      if (e instanceof Exit) code = e.code;
      else throw e;
    }
    stdout += outDec.decode();
    stderr += errDec.decode();
    return { code, stdout, stderr };
  };
  return {
    status: { state: 'ready', version: 'node yowasp' },
    onStatus(l) {
      l(this.status);
      return () => {};
    },
    async start() {},
    compile(job) {
      const p = chain.then(() => compileOne(job));
      chain = p.then(
        () => {},
        () => {},
      );
      return p;
    },
    dispose() {},
  };
}

export { readFile };
