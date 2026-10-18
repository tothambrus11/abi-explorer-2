// The extension's settings, and the C/C++ settings of other extensions that
// say where a project's compile commands are.

import path from 'node:path';
import * as vscode from 'vscode';
import type { InitializationOptions } from 'abi-explorer-lsp/protocol';

export function initializationOptions(cacheDirectory: string): InitializationOptions {
  const settings = vscode.workspace.getConfiguration('abiExplorer');
  return {
    cacheDirectory,
    hoverImages: true,
    inlayHints: settings.get<'records' | 'members' | 'off'>('inlayHints', 'records'),
    compileCommandsDir: settings.get<string>('compileCommandsDir') || borrowedCompileCommandsDir(),
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
  const clangd = vscode.workspace
    .getConfiguration('clangd')
    .get<string[]>('arguments', [])
    .find((argument) => argument.startsWith('--compile-commands-dir='));
  if (clangd) return expandWorkspaceFolder(clangd.slice('--compile-commands-dir='.length));

  const cpptools = vscode.workspace.getConfiguration('C_Cpp.default').get<string>('compileCommands');
  if (cpptools) return path.dirname(expandWorkspaceFolder(cpptools));
  return undefined;
}

function expandWorkspaceFolder(value: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return value.replace(/\$\{workspaceFolder\}/g, folder);
}
