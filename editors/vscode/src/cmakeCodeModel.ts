// CMake Tools' code model as compile commands.
//
// CMake Tools knows each target's flags, include paths and defines from the
// CMake file API, including for files no compile_commands.json lists yet. The
// shapes below are the parts of its published API (`vscode-cmake-tools`,
// `CodeModel.Content`) this reads; it is kept free of `vscode` so it can be
// tested on its own.

import path from 'node:path';
import type { CompileCommand } from '@abi-explorer/shared/protocol';

export interface CodeModelContent {
  configurations: { projects: { sourceDirectory?: string; targets: CodeModelTarget[] }[] }[];
  toolchains?: Map<string, { path: string }>;
}

export interface CodeModelTarget {
  sourceDirectory?: string;
  fileGroups?: CodeModelFileGroup[];
}

export interface CodeModelFileGroup {
  sources: string[];
  language?: string;
  compileCommandFragments?: string[];
  includePath?: { path: string; isSystem?: boolean }[];
  defines?: string[];
  isGenerated?: boolean;
}

/**
 * `exists` settles what CMake Tools leaves open: a relative source is relative
 * to its target's directory in some versions and to the project's in others.
 */
export function codeModelCommands(
  model: CodeModelContent,
  splitFragment: (fragment: string) => string[],
  exists: (file: string) => boolean,
): CompileCommand[] {
  const commands: CompileCommand[] = [];
  for (const configuration of model.configurations) {
    for (const project of configuration.projects) {
      for (const target of project.targets) {
        const directory = target.sourceDirectory ?? project.sourceDirectory;
        if (!directory) continue;
        const resolve = (source: string) => {
          if (path.isAbsolute(source)) return source;
          const inTarget = path.resolve(directory, source);
          return exists(inTarget) || !project.sourceDirectory
            ? inTarget
            : path.resolve(project.sourceDirectory, source);
        };
        for (const group of target.fileGroups ?? []) {
          if (group.language !== 'C' && group.language !== 'CXX') continue;
          const compiler =
            model.toolchains?.get(group.language)?.path ?? (group.language === 'C' ? 'cc' : 'c++');
          const flags = [
            ...(group.compileCommandFragments ?? []).flatMap(splitFragment),
            ...(group.includePath ?? []).flatMap((include) =>
              include.isSystem ? ['-isystem', include.path] : [`-I${include.path}`],
            ),
            ...(group.defines ?? []).map((define) => `-D${define}`),
          ];
          for (const source of group.sources) {
            const file = resolve(source);
            commands.push({ directory, file, arguments: [compiler, ...flags, file] });
          }
        }
      }
    }
  }
  return commands;
}
