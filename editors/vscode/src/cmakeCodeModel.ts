// CMake Tools' code model as compile commands.
//
// CMake Tools knows each target's flags, include paths and defines from the
// CMake file API, including for files no compile_commands.json lists yet. The
// shapes below are the parts of its published API (`vscode-cmake-tools`,
// `CodeModel.Content`) this reads; it is kept free of `vscode` so it can be
// tested on its own.

import type { CompileCommand } from 'abi-explorer-lsp/protocol';

export interface CodeModelContent {
  configurations: { projects: { targets: CodeModelTarget[] }[] }[];
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

export function codeModelCommands(model: CodeModelContent, splitFragment: (fragment: string) => string[]): CompileCommand[] {
  const commands: CompileCommand[] = [];
  for (const configuration of model.configurations) {
    for (const project of configuration.projects) {
      for (const target of project.targets) {
        const directory = target.sourceDirectory;
        if (!directory) continue;
        for (const group of target.fileGroups ?? []) {
          if (group.language !== 'C' && group.language !== 'CXX') continue;
          const compiler = model.toolchains?.get(group.language)?.path ?? (group.language === 'C' ? 'cc' : 'c++');
          const flags = [
            ...(group.compileCommandFragments ?? []).flatMap(splitFragment),
            ...(group.includePath ?? []).flatMap((include) => (include.isSystem ? ['-isystem', include.path] : [`-I${include.path}`])),
            ...(group.defines ?? []).map((define) => `-D${define}`),
          ];
          for (const source of group.sources) {
            commands.push({ directory, file: source, arguments: [compiler, ...flags, source] });
          }
        }
      }
    }
  }
  return commands;
}
