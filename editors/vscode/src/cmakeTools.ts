// Pushes CMake Tools' compile commands to the server whenever CMake configures.

import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { splitCommandLine } from 'abi-explorer-lsp/commandLine';
import { compileCommandsNotification } from 'abi-explorer-lsp/protocol';
import { codeModelCommands, type CodeModelContent } from './cmakeCodeModel.ts';

interface CMakeToolsApi {
  getProject(folder: vscode.Uri): Promise<CMakeProject | undefined>;
  onActiveProjectChanged: vscode.Event<vscode.Uri | undefined>;
}

interface CMakeProject {
  codeModel: CodeModelContent | undefined;
  onCodeModelChanged: vscode.Event<void>;
}

const CMAKE_TOOLS = 'ms-vscode.cmake-tools';

export async function followCMakeTools(client: LanguageClient, subscriptions: vscode.Disposable[]): Promise<void> {
  const extension = vscode.extensions.getExtension<{ getApi(version: number): Promise<CMakeToolsApi> }>(CMAKE_TOOLS);
  if (!extension) return;
  const api = await (await extension.activate()).getApi(1);
  let projectSubscription: vscode.Disposable | undefined;

  const follow = async (folder: vscode.Uri | undefined) => {
    projectSubscription?.dispose();
    const project = folder && (await api.getProject(folder));
    if (!project) return;
    const push = () => {
      if (!project.codeModel) return;
      const split = (fragment: string) => splitCommandLine(fragment, process.platform === 'win32' ? 'win32' : 'posix');
      void client.sendNotification(compileCommandsNotification, {
        source: 'CMake Tools',
        commands: codeModelCommands(project.codeModel, split),
      });
    };
    projectSubscription = project.onCodeModelChanged(push);
    push();
  };

  subscriptions.push(api.onActiveProjectChanged(follow), { dispose: () => projectSubscription?.dispose() });
  await follow(vscode.workspace.workspaceFolders?.[0]?.uri);
}
