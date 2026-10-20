// "ABI Explorer: Choose Target": lay the project out for another target, or
// go back to its own. Writes `abiExplorer.target`, which restarts the server.

import * as vscode from 'vscode';
import { TARGETS } from '@abi-explorer/shared/targets';

export async function chooseTarget(): Promise<void> {
  const settings = vscode.workspace.getConfiguration('abiExplorer');
  const current = settings.get<string>('target', '');
  const projectOwn: vscode.QuickPickItem = {
    label: "The project's own",
    description: 'from its compile commands',
  };
  const items: vscode.QuickPickItem[] = [
    projectOwn,
    ...TARGETS.map(({ triple, description }) => ({ label: triple, description })),
  ];
  for (const item of items) {
    item.picked = item === projectOwn ? current === '' : item.label === current;
  }
  const quickPick = vscode.window.createQuickPick();
  quickPick.items = items;
  quickPick.activeItems = items.filter((item) => item.picked);
  quickPick.placeholder = 'A target to lay structs out for, or type any triple clang accepts';
  const chosen = await new Promise<string | undefined>((resolve) => {
    quickPick.onDidAccept(() => {
      const item = quickPick.selectedItems[0];
      resolve(item ? (item === projectOwn ? '' : item.label) : quickPick.value.trim());
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      resolve(undefined);
    });
    quickPick.show();
  });
  quickPick.dispose();
  if (chosen === undefined || chosen === current) return;
  const scope = vscode.workspace.workspaceFolders
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await settings.update('target', chosen || undefined, scope);
}

/** A status bar item while a target is set, so layouts are never mistaken for the project's own. */
export function targetStatus(): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(
    'abiExplorer.target',
    vscode.StatusBarAlignment.Right,
  );
  item.name = 'ABI Explorer Target';
  item.command = 'abiExplorer.chooseTarget';
  const update = () => {
    const target = vscode.workspace
      .getConfiguration('abiExplorer')
      .get<string>('target', '')
      .trim();
    item.text = `$(chip) ${target}`;
    item.tooltip = `ABI Explorer lays structs out for ${target}, not the project's own target. Click to change.`;
    if (target) item.show();
    else item.hide();
  };
  update();
  const listener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('abiExplorer.target')) update();
  });
  return vscode.Disposable.from(item, listener);
}
