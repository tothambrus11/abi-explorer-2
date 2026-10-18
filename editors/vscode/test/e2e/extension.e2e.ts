// The packaged extension in real VS Code (code-server), driven by Playwright:
// inlay hints, hovers, code actions and the Struct Layout view on the fixture project, with
// a screenshot of each for review.

import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  copyFixtureProject,
  LOCAL_ENGINE,
  type FixtureProject,
} from '../../../server/test/support/fixtureProject.ts';
import { startCodeServer, type CodeServer } from './codeServer.ts';

const SCREENSHOTS = path.join(import.meta.dirname, '..', '..', '..', 'screenshots');
const CODE_SERVER_ENTRY = process.env.CODE_SERVER_ENTRY ?? '';

test.skip(!CODE_SERVER_ENTRY, 'set CODE_SERVER_ENTRY to code-server/out/node/entry.js');

let project: FixtureProject | undefined;
let codeServer: CodeServer | undefined;

test.beforeAll(async () => {
  project = copyFixtureProject();
  codeServer = await startCodeServer({
    entry: CODE_SERVER_ENTRY,
    vsix: path.join(import.meta.dirname, '..', '..', 'dist', 'abi-explorer.vsix'),
    workspace: project.root,
    engineDirectory: LOCAL_ENGINE,
    port: 8123,
    settings: {
      'workbench.colorTheme': 'Default Dark Modern',
      'workbench.startupEditor': 'none',
      'workbench.tips.enabled': false,
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'chat.disableAIFeatures': true,
      'editor.minimap.enabled': false,
      'editor.hover.delay': 100,
      'editor.fontSize': 14,
      'editor.inlayHints.enabled': 'on',
      'window.commandCenter': false,
    },
  });
});

test.afterAll(() => {
  codeServer?.stop();
  project?.remove();
});

test('hovers, inlay hints and the layout view', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(codeServer!.url);
  await openFile(page, 'main.cpp');

  // Inlay hints arrive once the first analysis is done.
  await expect(page.locator('.view-lines')).toContainText('40 B · align 8 · 9 B padding', {
    timeout: 60_000,
  });
  await expect(page.locator('.view-lines')).toContainText('64 B · align 8 · 10 B padding');

  // The caret inside Packet opens it in the view.
  await goToLine(page, 12, 20);
  await page.getByRole('button', { name: 'Struct Layout Section' }).click();
  // Room for the view: the file tree folded away, the side bar wider.
  await page.locator('.pane-header', { hasText: path.basename(project!.root) }).click();
  await dragSash(page, 420);
  const view = layoutView(page);
  await expect(view.locator('.record.open .record-name')).toHaveText('Packet', { timeout: 30_000 });
  await expect(view.locator('tr.highlighted .label')).toHaveText('checksum');
  await expect(view.locator('.byte')).toHaveCount(40);
  await expect(view.locator('button.copy')).toBeVisible();
  await page.screenshot({ path: path.join(SCREENSHOTS, 'vscode-layout-view.png') });

  // Clicking a member in the view moves the caret to it.
  await view.locator('tr[data-member]', { hasText: 'length' }).click();
  await expect(page.locator('.statusbar')).toContainText('Ln 11, Col');

  await hoverToken(page, 'Packet');
  const hover = page.locator('.monaco-hover:visible');
  await expect(hover).toContainText('struct Packet', { timeout: 15_000 });
  await expect(hover).toContainText('9 B padding');
  await expect(hover).toContainText('the members would fit in 32 B, 8 B less');
  await expect(hover.locator('img')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENSHOTS, 'vscode-record-hover.png') });

  await page.mouse.move(0, 0);
  await hoverToken(page, 'checksum');
  await expect(hover).toContainText('Packet::checksum std::uint16_t · offset 8 · 2 B · align 2', {
    timeout: 15_000,
  });
  await page.waitForTimeout(500); // The hover fades in.
  await page.screenshot({ path: path.join(SCREENSHOTS, 'vscode-member-hover.png') });

  // A use of a library type hovers with its layout too.
  await page.mouse.move(0, 0);
  await hoverToken(page, 'vector');
  await expect(hover).toContainText('class std::vector<int', { timeout: 15_000 });
  await expect(hover).toContainText('24 B · align 8');

  // The refactorings on Packet.
  await page.mouse.move(0, 0);
  await goToLine(page, 9, 10);
  await page.keyboard.press('Control+.');
  await expect(page.getByText('Reorder members by alignment (40 B → 32 B)')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('Pin layout with static_assert (40 B, align 8)')).toBeVisible();
  await page.screenshot({ path: path.join(SCREENSHOTS, 'vscode-code-actions.png') });
  await page.keyboard.press('Escape');

  // Another target, chosen from the list: Packet as 32-bit Arm lays it out.
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('ABI Explorer: Choose Target');
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: /armv7-unknown-linux-gnueabihf/ }).click();
  await expect(page.locator('.view-lines')).toContainText('24 B · align 4 · 5 B padding', {
    timeout: 60_000,
  });
});

async function openFile(page: Page, name: string): Promise<void> {
  await page.getByRole('treeitem', { name }).click({ timeout: 60_000 });
  await expect(page.locator('.tab.active')).toContainText(name);
}

/** Drags the side bar's right edge until the side bar is `width` wide. */
async function dragSash(page: Page, width: number): Promise<void> {
  const sidebar = (await page.locator('.part.sidebar').boundingBox())!;
  const y = sidebar.y + sidebar.height / 2;
  await page.mouse.move(sidebar.x + sidebar.width + 1, y);
  await page.mouse.down();
  await page.mouse.move(sidebar.x + width, y, { steps: 5 });
  await page.mouse.up();
  // Off the view, so hovering a member does not stand in for the caret's.
  await page.mouse.move(sidebar.x + width + 400, y);
}

async function goToLine(page: Page, line: number, column: number): Promise<void> {
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+G');
  await page.keyboard.type(`${line}:${column}`);
  await page.keyboard.press('Enter');
}

async function hoverToken(page: Page, token: string): Promise<void> {
  await page
    .locator('.view-lines span span', { hasText: new RegExp(`^${token}$`) })
    .first()
    .hover();
}

/** The webview's document: two iframes deep. */
function layoutView(page: Page) {
  return page.frameLocator('iframe.webview.ready').frameLocator('iframe#active-frame');
}
