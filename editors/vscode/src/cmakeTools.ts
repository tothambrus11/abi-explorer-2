// Sends CMake Tools' compile commands to the server whenever CMake configures,
// and again whenever the server (re)starts.

import fs from 'node:fs';
import * as vscode from 'vscode';
import { State, type LanguageClient } from 'vscode-languageclient/node';
import { splitCommandLine } from '@abi-explorer/shared/splitCommandLine';
import { compileCommandsNotification } from '@abi-explorer/shared/protocol';
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

/** Follows CMake Tools for as long as `client` lives; nothing happens without it. */
export async function followCMakeTools(
  client: LanguageClient,
  output: vscode.LogOutputChannel,
): Promise<vscode.Disposable> {
  const extension = vscode.extensions.getExtension<{
    getApi(version: number): Promise<CMakeToolsApi>;
  }>(CMAKE_TOOLS);
  // Activating CMake Tools configures CMake, so only where there is a CMake project.
  const isCMakeProject = (await vscode.workspace.findFiles('CMakeLists.txt', null, 1)).length > 0;
  if (!extension || !isCMakeProject) return new vscode.Disposable(() => {});

  let api: CMakeToolsApi;
  try {
    api = await (await extension.activate()).getApi(1);
  } catch (error) {
    output.warn(`CMake Tools gave no API, so its compile commands are not used: ${String(error)}`);
    return new vscode.Disposable(() => {});
  }

  let project: CMakeProject | undefined;
  let projectSubscription: vscode.Disposable | undefined;
  const style = process.platform === 'win32' ? 'win32' : 'posix';
  const push = () => {
    if (!project?.codeModel || client.state !== State.Running) return;
    const commands = codeModelCommands(
      project.codeModel,
      (fragment) => splitCommandLine(fragment, style),
      fs.existsSync,
    );
    client
      .sendNotification(compileCommandsNotification, { source: 'CMake Tools', commands })
      .catch(() => {});
  };
  let followed = 0;
  const follow = async (folder: vscode.Uri | undefined) => {
    // Projects can switch again while one is looked up; only the newest switch counts.
    const switchNumber = ++followed;
    let next: CMakeProject | undefined;
    try {
      next = folder && (await api.getProject(folder));
    } catch (error) {
      output.warn(`CMake Tools has no project for ${folder?.fsPath}: ${String(error)}`);
    }
    if (switchNumber !== followed) return;
    projectSubscription?.dispose();
    project = next;
    projectSubscription = project?.onCodeModelChanged(push);
    push();
  };

  const disposables = [
    api.onActiveProjectChanged(follow),
    client.onDidChangeState(({ newState }) => {
      if (newState === State.Running) push();
    }),
    { dispose: () => projectSubscription?.dispose() },
  ];
  await follow(vscode.workspace.workspaceFolders?.[0]?.uri);
  return vscode.Disposable.from(...disposables);
}
