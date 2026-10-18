// The engine request for one document: the user's flags, the user's system
// headers, and the engine's own builtin headers where the compiler's were (or
// first, where the compiler named none, as MSVC does and clang-cl would).

import { ENGINE_RELEASE } from '../engine/engineFiles.ts';
import type { PathMap } from '../engine/pathMap.ts';
import type { EngineRequest } from '../engine/engineTypes.ts';
import { mapPathOptions, type Language, type PreparedCommand } from './commandLine.ts';
import type { Toolchain } from './toolchain.ts';

/** Where the engine keeps clang's builtin headers inside its own filesystem. */
export const ENGINE_RESOURCE_DIRECTORY = `/usr/lib/clang/${ENGINE_RELEASE.clangMajor}`;

export interface RequestInputs {
  file: string;
  text: string;
  language: Language;
  command: PreparedCommand;
  toolchain: Toolchain;
  pathMap: PathMap;
}

export function buildEngineRequest(inputs: RequestInputs): EngineRequest {
  const { command, toolchain, pathMap } = inputs;
  const flags = [`-resource-dir=${ENGINE_RESOURCE_DIRECTORY}`, '-nostdinc'];
  const includes = toolchain.systemIncludes.some((include) => include.kind === 'builtin')
    ? toolchain.systemIncludes
    : [{ path: '', kind: 'builtin' as const }, ...toolchain.systemIncludes];
  for (const include of includes) {
    if (include.kind === 'builtin') flags.push('-isystem', `${ENGINE_RESOURCE_DIRECTORY}/include`);
    else {
      flags.push(
        include.kind === 'framework' ? '-iframework' : '-isystem',
        pathMap.toGuest(include.path),
      );
    }
  }
  if (
    toolchain.msvcVersion &&
    !command.flags.some((flag) => flag.startsWith('-fms-compatibility-version'))
  ) {
    flags.push(`-fms-compatibility-version=${toolchain.msvcVersion}`);
  }
  flags.push(...mapPathOptions(command.flags, (value) => pathMap.toGuest(value)));
  return {
    source: inputs.text,
    filename: pathMap.toGuest(inputs.file),
    lang: inputs.language,
    triple: toolchain.triple,
    flags,
    resourceDir: '',
    sysroot: '',
    includeSystemRecords: true,
  };
}

/**
 * The request for laying the document out for another target than the
 * project's: its own flags, less those that pick or tune a target or its
 * headers, over the engine's bundled libc++ and musl.
 */
export function buildCrossTargetRequest(inputs: RequestInputs): EngineRequest {
  const flags: string[] = [];
  const own = inputs.command.flags;
  for (let index = 0; index < own.length; index++) {
    const flag = own[index]!;
    if (TARGET_OPTIONS_WITH_VALUE.has(flag)) {
      index++;
      continue;
    }
    const tunesTarget =
      (flag.startsWith('-m') && !/^-m(no-)?ms-bitfields$/.test(flag)) ||
      /^(--target=|--sysroot=|--gcc-toolchain=|-resource-dir=|-nostdinc|-nostdlib)/.test(flag);
    if (!tunesTarget) flags.push(flag);
  }
  return {
    source: inputs.text,
    filename: inputs.pathMap.toGuest(inputs.file),
    lang: inputs.language,
    triple: inputs.toolchain.triple,
    flags: mapPathOptions(flags, (value) => inputs.pathMap.toGuest(value)),
    includeSystemRecords: true,
  };
}

const TARGET_OPTIONS_WITH_VALUE = new Set([
  '-target',
  '--target',
  '-isysroot',
  '--sysroot',
  '-resource-dir',
  '--gcc-toolchain',
  '-arch',
]);
