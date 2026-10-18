// The engine itself: clang-abi-wasm instantiated with the host filesystem
// mounted, answering one request at a time.
//
// Synchronous and slow by nature (a translation unit with standard headers is
// seconds), so it only ever runs inside the worker in `engineWorker.ts`.

import { pathToFileURL } from 'node:url';
import type { EngineFiles } from './engineFiles.ts';
import { createHostFs, type EmscriptenFs } from './hostFs.ts';
import type { Mount } from './pathMap.ts';
import type { EngineRequest, EngineResponse } from './engineTypes.ts';

export interface Engine {
  readonly clangVersion: string;
  query(request: EngineRequest): EngineResponse;
}

interface EmscriptenModule {
  FS: EmscriptenFs;
  cwrap(name: string, returns: 'string', args: string[]): (...args: string[]) => string;
}

type ModuleFactory = (options: {
  locateFile: (name: string) => string;
  print: (text: string) => void;
  printErr: (text: string) => void;
}) => Promise<EmscriptenModule>;

export async function loadEngine(files: EngineFiles, mounts: readonly Mount[]): Promise<Engine> {
  const glue = (await import(pathToFileURL(files['abi_query.mjs']).href)) as {
    default: ModuleFactory;
  };
  const module = await glue.default({
    locateFile: (name) => (name in files ? files[name as keyof EngineFiles] : name),
    print: () => {},
    printErr: () => {},
  });

  const hostFs = createHostFs(module.FS);
  for (const mount of mounts) {
    module.FS.mkdirTree(mount.guest);
    module.FS.mount(hostFs, { root: mount.host }, mount.guest);
  }

  const abiQuery = module.cwrap('abi_query', 'string', ['string']);
  const abiVersion = module.cwrap('abi_version', 'string', []);
  return {
    clangVersion: abiVersion(),
    query: (request) => JSON.parse(abiQuery(JSON.stringify(request))) as EngineResponse,
  };
}
