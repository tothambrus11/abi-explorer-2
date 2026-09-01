import { test, expect, type Page, type Locator } from '@playwright/test';

const PHONE = { width: 390, height: 844 };

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#results')).toBeVisible({ timeout: 240_000 });
}

/** The tab strip a panel's tab sits in: what "the same group" means to dockview. */
const tab = (page: Page, name: string): Locator =>
  page.locator('.dv-tab').filter({ hasText: name }).first();

/**
 * Nothing is off the screen. Every one of these was, at some point, and none of
 * it showed up in a test: a menu anchored to its own button ran off the left of
 * a 390px screen, and the options panel opened as a *row* in a bar that no
 * longer wraps and went off the right. Both look fine at 1440px.
 */
async function withinViewport(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  expect(box, 'the element has a box at all').not.toBeNull();
  const size = page.viewportSize()!;
  expect.soft(box!.x, `left edge of ${await target.getAttribute('id')}`).toBeGreaterThanOrEqual(0);
  expect.soft(box!.x + box!.width, 'right edge').toBeLessThanOrEqual(size.width);
  expect(box!.width, 'and it is not squeezed to nothing').toBeGreaterThan(120);
}

test.describe('on a phone', () => {
  test.use({ viewport: PHONE });

  test('the actions keep the title company instead of taking a row of their own', async ({
    page,
  }) => {
    await ready(page);
    const mark = (await page.locator('.brand-mark').boundingBox())!;
    const share = (await page.locator('.btn.share').boundingBox())!;
    // Same row: their centres line up. Wrapped, they were 44px apart.
    expect(Math.abs(mark.y + mark.height / 2 - (share.y + share.height / 2))).toBeLessThan(6);
  });

  test('the theme menu opens on the screen', async ({ page }) => {
    await ready(page);
    await page.click('button[aria-label="Choose theme"]');
    const menu = page.locator('[role=listbox][aria-label=Themes]');
    await expect(menu).toBeVisible();
    await withinViewport(page, menu);
    // The whole name, not "zed Light".
    await expect(menu).toContainText('Solarized Light');
  });

  test('the details popover opens on the screen and says what answered', async ({ page }) => {
    await ready(page);
    await page.click('#info-button');
    const panel = page.locator('#info-panel');
    await expect(panel).toBeVisible();
    await withinViewport(page, panel);
    await expect(panel).toContainText('clang version');
    await expect(panel).toContainText('musl');
  });

  test('the options panel opens on the screen', async ({ page }) => {
    await ready(page);
    await page.click('.more > summary');
    const grid = page.locator('.more[open] .grid');
    await expect(grid).toBeVisible();
    await withinViewport(page, grid);
    // The last row is reachable rather than off the right-hand edge.
    await expect(page.locator('#show-internal')).toBeVisible();
  });

  test('Diagnostics shares the Layout tab strip, and says how much it holds', async ({ page }) => {
    await ready(page);
    const layout = (await tab(page, 'Layout').boundingBox())!;
    const diagnostics = (await tab(page, 'Diagnostics').boundingBox())!;
    expect(Math.abs(layout.y - diagnostics.y), 'same tab strip').toBeLessThan(4);

    // Nothing to report: no count, rather than a [0] to reassure nobody.
    await expect(tab(page, 'Diagnostics')).not.toContainText('[');
    await page.locator('.monaco-editor .view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nstruct Broken { int x }');
    // Two, from this clang, for this snippet: an error and the note-free
    // warning beside it. Pinned rather than loosened: the number moving is
    // how a regression that starts counting notes again would show up.
    await expect(tab(page, 'Diagnostics')).toContainText('[2]');
  });

  test('whether it compiled is on the Code tab', async ({ page }) => {
    await ready(page);
    await expect(tab(page, 'Code').locator('[role=status].ok')).toBeVisible();
    await page.locator('.monaco-editor .view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nstruct Broken { int x }');
    await expect(tab(page, 'Code').locator('[role=status].error')).toBeVisible();
  });

  test('nothing states the compiler except the details popover', async ({ page }) => {
    await ready(page);
    // The footer that used to carry this is gone: three lines of prose across
    // the bottom of a 390px screen was a quarter of the viewport spent on text
    // nobody read twice. What it said is in the popover, and nowhere else.
    await expect(page.locator('#compiler-version')).toBeHidden();
    await page.click('#info-button');
    await expect(page.locator('#compiler-version')).toBeVisible();
  });
});

test.describe('on a desktop', () => {
  test('Diagnostics keeps a panel of its own', async ({ page }) => {
    await ready(page);
    const layout = (await tab(page, 'Layout').boundingBox())!;
    const diagnostics = (await tab(page, 'Diagnostics').boundingBox())!;
    // Its own group, below the editor, not a tab beside the layout.
    expect(diagnostics.y, 'a strip of its own, lower down').toBeGreaterThan(layout.y + 100);
    // The popover is where the compiler is named, on any width.
    await page.hover('#info-button');
    await expect(page.locator('#compiler-version')).toBeVisible();
  });
});
