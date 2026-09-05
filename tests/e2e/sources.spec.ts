// Several sources at once: each with its panels, its options and its answer,
// and the panels of one source coming forward together wherever they are.
//
// Most of this is about what happens *across* groups, which is the part that
// has no counterpart in a single-source session and the part a reader
// arranging panels by hand would notice first.

import { test, expect, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#results').first()).toBeVisible({ timeout: 240_000 });
  await expect(page.locator('.monaco-editor .view-lines')).toBeVisible();
}

/** Every group as "label: tab | tab*", the active tab starred. */
const groups = (page: Page) =>
  page
    .locator('.dv-groupview')
    .evaluateAll((gs) =>
      gs.map(
        (g) =>
          (g.querySelector('.dock-group-label')?.textContent ?? '-') +
          ': ' +
          [...g.querySelectorAll('.dv-tab')]
            .map(
              (t) =>
                t.textContent.trim().replace(/\s+/g, ' ') +
                (t.classList.contains('dv-active-tab') ? '*' : ''),
            )
            .join(' | '),
      ),
    );

/** The tab of `source` in the group labelled `kind`. */
const tab = (page: Page, kind: string, source: string) =>
  page
    .locator(`.dv-groupview:has(.dock-group-label:text-is("${kind}"))`)
    .locator('.dv-tab', { hasText: source });

const activeIndex = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __abix: { store: { activeIndex: number } } }).__abix.store
        .activeIndex,
  );

/** The target chip of the Source panel on screen. */
const targetChip = (page: Page) =>
  page.locator('section.controls.compact:visible [aria-label="Target"]').first();

/** Puts the source on screen on `triple`, through its own row's target menu. */
async function setTarget(page: Page, triple: string): Promise<void> {
  await targetChip(page).click();
  await page.locator('.field-menu input').fill(triple);
  await page.locator('.field-menu [role=option]').first().click();
  await expect(page.locator('.field-menu')).toHaveCount(0);
}

/** Two sources, the second holding `struct B`. */
async function twoSources(page: Page): Promise<void> {
  await ready(page);
  await page.click('button[aria-label="Add source"]');
  await page.locator('.monaco-editor:visible').click();
  await page.keyboard.type('struct B { char c; int i; };');
  await expect(page.locator('.summary .value').first()).toHaveText('8', { timeout: 30_000 });
}

test.describe('several sources', () => {
  test('a source pressed anywhere comes forward everywhere', async ({ page }) => {
    await twoSources(page);
    await expect
      .poll(() => groups(page))
      .toEqual([
        'Source: Source 1 | Source 2*',
        'Diagnostics: Source 1 | Source 2*',
        'Layout: Source 1 | Source 2*',
      ]);
    await tab(page, 'Layout', 'Source 1').click();
    await expect
      .poll(() => groups(page))
      .toEqual([
        'Source: Source 1* | Source 2',
        'Diagnostics: Source 1* | Source 2',
        'Layout: Source 1* | Source 2',
      ]);
    await expect.poll(() => activeIndex(page)).toBe(0);
    await tab(page, 'Diagnostics', 'Source 2').click();
    await expect.poll(() => activeIndex(page)).toBe(1);
    await expect
      .poll(() => groups(page))
      .toEqual([
        'Source: Source 1 | Source 2*',
        'Diagnostics: Source 1 | Source 2*',
        'Layout: Source 1 | Source 2*',
      ]);
  });

  test('pointing at a layout brings its code forward; pointing at a tab does not', async ({
    page,
  }) => {
    await twoSources(page);
    // Two Layout groups side by side, so a layout that is not the focused
    // source's is on screen to be pointed at.
    await page.evaluate(() => {
      const w = window as unknown as {
        __abix: {
          store: { sources: { id: number }[] };
          dock: {
            api: { getPanel(id: string): { api: { moveTo(o: unknown): void }; group: unknown } };
          };
        };
      };
      const [a, b] = w.__abix.store.sources;
      const api = w.__abix.dock.api;
      api.getPanel(`layout:${String(b!.id)}`).api.moveTo({
        group: api.getPanel(`layout:${String(a!.id)}`).group,
        position: 'right',
      });
    });
    await tab(page, 'Source', 'Source 1').click();
    await expect.poll(() => activeIndex(page)).toBe(0);

    // A tab hovered is not a tab pressed.
    await tab(page, 'Layout', 'Source 2').hover();
    await page.waitForTimeout(150);
    await expect.poll(() => activeIndex(page)).toBe(0);

    // The layout itself is the source's: pointing at it brings the source's
    // code forward, but chooses nothing: the selection and the link stay.
    await page.waitForTimeout(900); // hash sync is debounced
    const url = page.url();
    await page
      .locator('.dock-panel-layout:visible')
      .last()
      .hover({ position: { x: 120, y: 120 } });
    await expect
      .poll(() => groups(page))
      .toEqual([
        'Source: Source 1 | Source 2*',
        'Diagnostics: Source 1 | Source 2*',
        'Layout: Source 1*',
        'Layout: Source 2*',
      ]);
    expect(await activeIndex(page)).toBe(0);
    await page.waitForTimeout(900);
    expect(page.url()).toBe(url);
    // Pointer gone, the chosen source is back.
    await page.mouse.move(600, 10);
    await expect
      .poll(() => groups(page))
      .toEqual([
        'Source: Source 1* | Source 2',
        'Diagnostics: Source 1* | Source 2',
        'Layout: Source 1*',
        'Layout: Source 2*',
      ]);
    // Pressing inside a peeked panel chooses its source.
    await page
      .locator('.dock-panel-layout:visible')
      .last()
      .click({ position: { x: 120, y: 120 } });
    await expect.poll(() => activeIndex(page)).toBe(1);
  });

  test('a source opened from a group’s "+" lands in that group', async ({ page }) => {
    await twoSources(page);
    // Two Source groups: Source 2's editor on its own, to the right.
    await page.evaluate(() => {
      const w = window as unknown as {
        __abix: {
          store: { sources: { id: number }[] };
          dock: {
            api: {
              getPanel(id: string): { api: { moveTo(o: unknown): void }; group: unknown };
            };
          };
        };
      };
      const [a, b] = w.__abix.store.sources;
      const api = w.__abix.dock.api;
      api.getPanel(`editor:${String(b!.id)}`).api.moveTo({
        group: api.getPanel(`editor:${String(a!.id)}`).group,
        position: 'right',
      });
    });
    await expect
      .poll(() => groups(page))
      .toEqual([
        'Source: Source 1*',
        'Source: Source 2*',
        'Diagnostics: Source 1 | Source 2*',
        'Layout: Source 1 | Source 2*',
      ]);
    // The "+" of the right-hand group: the new Source panel joins it, and the
    // new Layout and Diagnostics join their kinds.
    await page.locator('button[aria-label="Add source"]').nth(1).click();
    await expect
      .poll(() => groups(page))
      .toEqual([
        'Source: Source 1*',
        'Source: Source 2 | Source 3*',
        'Diagnostics: Source 1 | Source 2 | Source 3*',
        'Layout: Source 1 | Source 2 | Source 3*',
      ]);
  });

  test('the new-source button stays with the tabs, even when they overflow', async ({ page }) => {
    await ready(page);
    const plus = page.locator('.dock-group-add button[aria-label="Add source"]').first();
    const examples = page.locator('select[aria-label="Load an example"]').first();
    const firstTab = page.locator('.dv-tab').first();
    const box = async (l: typeof plus) => (await l.boundingBox())!;

    // Between the tabs and the examples: what it adds is a source, not an example.
    expect((await box(plus)).x).toBeGreaterThan((await box(firstTab)).x);
    expect((await box(plus)).x).toBeLessThan((await box(examples)).x);

    // Six sources in one group, then a window too narrow to show their tabs.
    for (let i = 0; i < 5; i++) {
      await plus.click();
      await page.waitForTimeout(150);
    }
    await expect(page.locator('.dv-tab', { hasText: 'Source 6' })).toHaveCount(3);
    await page.setViewportSize({ width: 620, height: 860 });
    await page.waitForTimeout(600);

    // The tabs scroll; the button does not go with them.
    await expect(plus).toBeVisible();
    const group = (await page.locator('.dv-groupview:has(.dv-tab)').first().boundingBox())!;
    const mark = await box(plus);
    expect(mark.x).toBeGreaterThanOrEqual(group.x);
    expect(mark.x + mark.width).toBeLessThanOrEqual(group.x + group.width);
  });

  test('a tab renames its source on a double click, and from its menu', async ({ page }) => {
    await twoSources(page);
    await tab(page, 'Source', 'Source 2').dblclick();
    const field = page.locator('.dv-tab input[aria-label="Rename Source 2"]');
    await expect(field).toBeFocused();
    await field.fill('packet.c');
    await field.press('Enter');
    await expect(page.locator('.dv-tab', { hasText: 'packet.c' })).toHaveCount(3);
    await expect(page.locator('.dv-tab', { hasText: 'Source 2' })).toHaveCount(0);

    // The menu, for whoever has no double click: it renames, closes the
    // panel, or removes the source.
    await tab(page, 'Layout', 'packet.c').click({ button: 'right' });
    const menu = page.locator('[role=menu][aria-label="Layout panel of packet.c"]');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Close this panel' }).click();
    await expect(tab(page, 'Layout', 'packet.c')).toHaveCount(0);
    await tab(page, 'Source', 'packet.c').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove packet.c' }).click();
    await expect(page.locator('.dv-tab', { hasText: 'packet.c' })).toHaveCount(0);
    await expect(page.locator('section.controls:not(.compact)')).toHaveCount(1);
  });

  test('a link carries the panel layout', async ({ page, browser }) => {
    await twoSources(page);
    // Two Layout groups side by side: an arrangement a default would not make.
    await page.evaluate(() => {
      const w = window as unknown as {
        __abix: {
          store: { sources: { id: number }[] };
          dock: {
            api: {
              getPanel(id: string): { api: { moveTo(o: unknown): void }; group: unknown };
            };
          };
        };
      };
      const [a, b] = w.__abix.store.sources;
      const api = w.__abix.dock.api;
      api.getPanel(`layout:${String(b!.id)}`).api.moveTo({
        group: api.getPanel(`layout:${String(a!.id)}`).group,
        position: 'right',
      });
    });
    await expect.poll(() => groups(page)).toHaveLength(4);
    await page.waitForTimeout(900); // hash sync is debounced

    // A reader with no arrangement of their own (a fresh context) opens on the
    // sharer's, panel for panel: where the panels are is part of what was
    // shared, and there is nothing to switch on.
    const reader = await browser.newContext();
    const shared = await reader.newPage();
    await shared.goto(page.url());
    await expect(shared.locator('#results').first()).toBeVisible({ timeout: 120_000 });
    await expect
      .poll(() => groups(shared))
      .toEqual([
        'Source: Source 1 | Source 2*',
        'Diagnostics: Source 1 | Source 2*',
        'Layout: Source 1*',
        'Layout: Source 2*',
      ]);

    // The sharer's arrangement is for this visit: it is not stored as the
    // reader's own, not on arrival and not for looking around (a peek), until
    // the reader rearranges it themselves.
    const stored = () => shared.evaluate(() => localStorage.getItem('abix-dock-layout-v3'));
    await shared.waitForTimeout(900); // the layout save is debounced too
    expect(await stored()).toBeNull();
    await shared.locator('.dock-panel-layout').nth(1).hover();
    await shared.locator('.topbar').hover();
    await shared.waitForTimeout(900);
    expect(await stored()).toBeNull();
    await shared.locator('button[aria-label^="Close the Diagnostics panel"]').first().click();
    await expect.poll(stored, { timeout: 5_000 }).not.toBeNull();
    await reader.close();

    // And Share has nothing to configure.
    await expect(page.locator('[aria-label="Share options"]')).toHaveCount(0);
    await expect(page.locator('.topbar .btn.share')).toHaveCount(1);
  });

  test('the name is a link that starts the session again', async ({ page }) => {
    await twoSources(page);
    await page.waitForTimeout(900); // hash sync is debounced
    expect(page.url()).toMatch(/#2\./);
    const before = page.url();

    // A plain press starts again: one source, the first example, and an
    // address bar carrying nothing of the session that was, once the sync has
    // written the new one.
    await expect(page.locator('a.brand')).toHaveAttribute('href', '/');
    await page.click('a.brand');
    await expect
      .poll(() => groups(page))
      // One source again: the groups drop their labels and the tabs say what
      // they are rather than which source they belong to.
      .toEqual([': Source*', ': Diagnostics*', ': Layout*']);
    await expect(page.locator('.monaco-editor')).toContainText('struct Example');
    await page.waitForTimeout(900);
    expect(page.url()).toMatch(/#2\./);
    expect(page.url()).not.toBe(before);

    // And it is one undo away, like everything else.
    await page.click('#undo');
    await expect(page.locator('.dv-tab', { hasText: 'Source 2' })).toHaveCount(3);
    await expect(page.locator('.monaco-editor:visible')).toContainText('struct B');
  });

  test('on a narrow screen every group takes the full width, and gets its place back', async ({
    page,
  }) => {
    await twoSources(page);
    const widths = () =>
      page
        .locator('.dv-groupview')
        .evaluateAll((gs) => gs.map((g) => Math.round(g.getBoundingClientRect().width)));
    const wide = page.viewportSize()!;
    const before = await widths();
    expect(new Set(before).size, 'side by side: not all the same width').toBeGreaterThan(1);
    await page.setViewportSize({ width: 390, height: 844 });
    // Stacked: every group as wide as the dock, one above the other.
    await expect.poll(async () => new Set(await widths()).size).toBe(1);
    expect((await widths())[0]).toBeGreaterThan(340);
    // The settings row inside a Source panel gives each control a row of its own.
    const rows = await page
      .locator('section.controls.compact')
      .first()
      .locator('.group')
      .evaluateAll((gs) => gs.map((g) => Math.round(g.getBoundingClientRect().width)));
    expect(new Set(rows).size, 'every group at the full row width').toBe(1);
    await page.setViewportSize(wide);
    // Back to the wide arrangement, give or take the rounding of a stored sash.
    await expect
      .poll(async () => (await widths()).map((w, i) => Math.abs(w - before[i]!) <= 6))
      .toEqual(before.map(() => true));
  });

  test('one icon holds the view: the panels, the sources and the way back', async ({ page }) => {
    await twoSources(page);
    // One view control in the bar, not two.
    await expect(page.locator('.topbar #view-button')).toHaveCount(1);
    await expect(page.locator('.topbar [aria-label="Reset panel layout"]')).toHaveCount(0);

    // An arrangement a default would not make.
    await page.evaluate(() => {
      const w = window as unknown as {
        __abix: {
          store: { sources: { id: number }[] };
          dock: {
            api: { getPanel(id: string): { api: { moveTo(o: unknown): void }; group: unknown } };
          };
        };
      };
      const [a, b] = w.__abix.store.sources;
      const api = w.__abix.dock.api;
      api.getPanel(`layout:${String(b!.id)}`).api.moveTo({
        group: api.getPanel(`layout:${String(a!.id)}`).group,
        position: 'right',
      });
    });
    await expect.poll(() => groups(page)).toHaveLength(4);

    // The reset is a button inside the same popup, and it closes it. The
    // arrangement goes back to the default; the source in focus stays the one
    // being worked on, which resetting the panels is no reason to change.
    await page.click('#view-button');
    await page.click('#reset-layout');
    await expect(page.locator('#view-panel')).toHaveCount(0);
    await expect
      .poll(() => groups(page))
      .toEqual([
        'Source: Source 1 | Source 2*',
        'Diagnostics: Source 1 | Source 2*',
        'Layout: Source 1 | Source 2*',
      ]);
    await expect.poll(() => activeIndex(page)).toBe(1);
  });

  test('a closed panel comes back from the sources menu; a removed source comes back from undo', async ({
    page,
  }) => {
    await twoSources(page);
    await tab(page, 'Diagnostics', 'Source 2').locator('button.close').click();
    await expect(tab(page, 'Diagnostics', 'Source 2')).toHaveCount(0);
    await page.click('#view-button');
    const box = page.locator('#view-panel input[aria-label="Diagnostics of Source 2"]');
    await expect(box).not.toBeChecked();
    await box.click();
    await expect(tab(page, 'Diagnostics', 'Source 2')).toHaveCount(1);
    await expect(box).toBeChecked();

    // Named from the same menu, and the tabs follow.
    const name = page.locator('#view-panel input[aria-label="Name of source 2"]');
    await name.fill('packet.c');
    await name.press('Enter');
    await expect(page.locator('.dv-tab', { hasText: 'packet.c' })).toHaveCount(3);

    await page.click('button[aria-label="Remove packet.c"]');
    await expect(page.locator('.dv-tab', { hasText: 'packet.c' })).toHaveCount(0);
    // The menu stays open: the press was inside it, and there may be more to do.
    await expect(page.locator('#view-panel')).toBeVisible();
    await expect(page.locator('#view-panel tbody tr')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.click('#undo');
    await expect(page.locator('.dv-tab', { hasText: 'packet.c' })).toHaveCount(3);
    await expect.poll(() => activeIndex(page)).toBe(1);
  });

  test('each source keeps its own options, and a link carries them', async ({ page, context }) => {
    await twoSources(page);
    // The second source's row is the one on screen; put it on another target.
    await setTarget(page, 'avr-unknown-unknown');
    await expect
      .poll(() => page.locator('.summary .value').first().textContent(), {
        timeout: 30_000,
      })
      .toBe('3');
    await tab(page, 'Source', 'Source 1').click();
    // The first source's row says x86-64 still, and so does its answer.
    await expect(targetChip(page)).toHaveText(/x86-64/);
    await expect
      .poll(() => page.locator('.summary .value').first().textContent(), {
        timeout: 30_000,
      })
      .toBe('40');

    await page.waitForTimeout(800); // hash sync is debounced
    const page2 = await context.newPage();
    await page2.goto(page.url());
    await expect(page2.locator('#results').first()).toBeVisible({ timeout: 120_000 });
    await tab(page2, 'Source', 'Source 2').click();
    await expect(targetChip(page2)).toHaveText(/AVR/);
  });
});
