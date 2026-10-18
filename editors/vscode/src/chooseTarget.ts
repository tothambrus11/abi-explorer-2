// "ABI Explorer: Choose Target": lay the project out for another target, or
// go back to its own. Writes `abiExplorer.target`, which restarts the server.

import * as vscode from 'vscode';

/** Targets whose layouts most often differ from a desktop's, by what people call them. */
const TARGETS: { triple: string; description: string }[] = [
  { triple: 'x86_64-linux-gnu', description: 'x86-64 Linux' },
  { triple: 'x86_64-pc-windows-msvc', description: 'x86-64 Windows (MSVC)' },
  { triple: 'i686-linux-gnu', description: '32-bit x86 Linux' },
  { triple: 'aarch64-linux-gnu', description: 'AArch64 Linux' },
  { triple: 'arm64-apple-macosx', description: 'Apple silicon macOS' },
  { triple: 'armv7-unknown-linux-gnueabihf', description: '32-bit Arm Linux' },
  { triple: 'thumbv7em-none-eabi', description: 'Cortex-M4/M7, bare metal' },
  { triple: 'riscv32-unknown-elf', description: '32-bit RISC-V, bare metal' },
  { triple: 'riscv64-linux-gnu', description: '64-bit RISC-V Linux' },
  { triple: 'wasm32-wasi', description: 'WebAssembly' },
  { triple: 'avr-none', description: 'AVR (Arduino)' },
  { triple: 'powerpc-linux-gnu', description: '32-bit PowerPC, big-endian' },
];

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
