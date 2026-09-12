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

  test('the theme is chosen from the view panel, which the bar has room for', async ({ page }) => {
    await ready(page);
    // The two-part theme control is not in the bar: with it, Share was off
    // the right of a 320px screen.
    await expect(page.locator('button[aria-label="Choose theme"]')).toHaveCount(0);
    await withinViewport(page, page.locator('.topbar .actions'));
    await page.click('#view-button');
    const panel = page.locator('#view-panel');
    await withinViewport(page, panel);
    const pick = panel.locator('select[aria-label="Theme"]');
    await expect(pick.locator('option', { hasText: 'Solarized Light' })).toHaveCount(1);
    const before = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--page'),
    );
    await pick.selectOption({ label: 'Solarized Light' });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--page')))
      .not.toBe(before);
    // And the light/dark toggle is in here too.
    const chosen = await pick.inputValue();
    await panel.locator('button[aria-label="Toggle light/dark theme"]').click();
    await expect(pick).not.toHaveValue(chosen);
  });

  test('the query row fits: every field a chip, the target taking the rest', async ({ page }) => {
    await ready(page);
    // The language is a chip like the standard and the target, not three
    // buttons; and nothing on the row is off the right of the screen. It used
    // to scroll sideways, with the target and the options out of sight.
    await expect(page.locator('.controls .segmented')).toHaveCount(0);
    for (const label of ['Language', 'Language standard', 'Target', 'More options']) {
      const chip = page.locator(`.controls [aria-label="${label}"]`).first();
      const box = (await chip.boundingBox())!;
      expect(box.x, `${label} starts on screen`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${label} ends on screen`).toBeLessThanOrEqual(PHONE.width);
    }
    // One line, whatever is on it.
    expect((await page.locator('.controls').first().boundingBox())!.height).toBeLessThan(44);
    // And the language chip works as the buttons did.
    await page.click('.controls [aria-label="Language"]');
    await page.locator('.field-menu [role=option]', { hasText: 'C++' }).click();
    await expect(page.locator('.controls [aria-label="Language"]').first()).toContainText('C++');
  });

  test('a row too narrow for the fields becomes one chip that opens them', async ({ page }) => {
    await ready(page);
    await page.setViewportSize({ width: 320, height: PHONE.height });
    // The fields are gone from the row: one chip stands for them, saying what
    // the query is, on one line and on the screen.
    const chip = page.locator('.controls .field-chip.summary').first();
    await expect(chip).toContainText('C · gnu23 · x86-64');
    await expect(page.locator('.controls [aria-label="Target"]')).toHaveCount(0);
    expect((await page.locator('.controls').first().boundingBox())!.height).toBeLessThan(44);
    await withinViewport(page, chip);

    // Pressing it opens the four of them, each on the screen, and the target
    // is read whole where it is chosen.
    await chip.click();
    const panel = page.locator('[role=dialog][aria-label="Query"]');
    await withinViewport(page, panel);
    await expect(panel.locator('[aria-label="Target"]')).toContainText('Linux (System V)');
    await panel.locator('[aria-label="Target"]').click();
    await page.locator('.field-menu input').fill('aarch64-apple');
    await page.locator('.field-menu [role=option]').first().click();
    await expect(chip).toContainText('AArch64 · macOS');
    // The panel stays while a field of its own is being used; Escape shuts it.
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    // A second source puts a row inside each Source panel, where it is
    // narrower still: one chip there too, never two lines.
    await page.setViewportSize(PHONE);
    await page.click('#view-button');
    await page.locator('#view-panel .add', { hasText: 'New source' }).click();
    await page.keyboard.press('Escape');
    const inPanel = page.locator('.controls.compact').first();
    await expect(inPanel.locator('.field-chip.summary')).toBeVisible();
    expect((await inPanel.boundingBox())!.height).toBeLessThan(44);
  });

  test('the examples move into the view panel, which the tab strip has no room for', async ({
    page,
  }) => {
    await ready(page);
    // Not in the strip: the tabs are what it is for, and the select crowded
    // out the source they name.
    await expect(page.locator('.dv-tabs-and-actions-container select.example')).toHaveCount(0);
    await page.click('#view-button');
    const panel = page.locator('#view-panel');
    await withinViewport(page, panel);
    await panel.locator('select.example').selectOption({ label: 'Bit-fields' });
    await expect(page.locator('.monaco-editor')).toContainText('unsigned');
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
    await page.click('#more-options');
    const grid = page.locator('[role=dialog][aria-label="More options"]');
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

  test('whether it compiled is on the Source tab', async ({ page }) => {
    await ready(page);
    await expect(tab(page, 'Source').locator('[role=status].ok')).toBeVisible();
    await page.locator('.monaco-editor .view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nstruct Broken { int x }');
    await expect(tab(page, 'Source').locator('[role=status].error')).toBeVisible();
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
