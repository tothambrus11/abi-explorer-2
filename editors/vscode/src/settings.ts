// The extension's settings, and the C/C++ settings of other extensions that
// say where a project's compile commands are.

import path from 'node:path';
import * as vscode from 'vscode';
import type { InitializationOptions } from '@abi-explorer/shared/protocol';

export function initializationOptions(cacheDirectory: string): InitializationOptions {
  const settings = vscode.workspace.getConfiguration('abiExplorer');
  return {
    cacheDirectory,
    hoverImages: true,
    inlayHints: settings.get<'records' | 'members' | 'off'>('inlayHints', 'records'),
    compileCommandsDir:
      expandWorkspaceFolder(settings.get<string>('compileCommandsDir', '')) ||
      borrowedCompileCommandsDir(),
    allowedCompilers: settings.get<string[]>('allowedCompilers', []),
    fallbackFlags: settings.get<string[]>('fallbackFlags', []),
  };
}

export function affectsServer(event: vscode.ConfigurationChangeEvent): boolean {
  return ['abiExplorer', 'clangd.arguments', 'C_Cpp.default.compileCommands'].some((section) =>
    event.affectsConfiguration(section),
  );
}

/**
 * Where clangd or the Microsoft C/C++ extension was told to look, so a project
 * set up for either works without setting anything here.
 */
function borrowedCompileCommandsDir(): string | undefined {
  // `--compile-commands-dir=build`, or the same as two arguments.
  const clangd = vscode.workspace.getConfiguration('clangd').get<string[]>('arguments', []);
  for (const [index, argument] of clangd.entries()) {
    if (argument.startsWith('--compile-commands-dir=')) {
      return expandWorkspaceFolder(argument.split('=')[1] ?? '');
    }
    if (argument === '--compile-commands-dir' && clangd[index + 1]) {
      return expandWorkspaceFolder(clangd[index + 1]!);
    }
  }

  // A path to the file, or (in newer versions) a list of them.
  const cpptools = vscode.workspace
    .getConfiguration('C_Cpp.default')
    .get<string | string[]>('compileCommands');
  const file = Array.isArray(cpptools) ? cpptools[0] : cpptools;
  return file ? path.dirname(expandWorkspaceFolder(file)) : undefined;
}

function expandWorkspaceFolder(value: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return value.replace(/\$\{workspaceFolder\}/g, folder);
}
