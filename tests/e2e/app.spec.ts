import { test, expect, type Page } from '@playwright/test';

async function waitReady(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#results')).toBeVisible({ timeout: 240_000 });
  await expect(page.locator('.monaco-editor .view-lines')).toBeVisible();
}

/** Move the mouse over a word on the first editor line containing `needle`. */
async function hoverWord(page: Page, needle: string, word: string): Promise<void> {
  const lines = page.locator('.monaco-editor .view-line');
  const texts = (await lines.allTextContents()).map((t) => t.replace(/\u00a0/g, ' '));
  const li = texts.findIndex((t) => t.includes(needle));
  expect(li, `line containing "${needle}"`).toBeGreaterThanOrEqual(0);
  const box = (await lines.nth(li).boundingBox())!;
  const col = texts[li]!.indexOf(word);
  const charW = await page.evaluate(() => {
    const s = document.querySelector('.monaco-editor .view-line span span')!;
    return s.getBoundingClientRect().width / s.textContent.length;
  });
  await page.mouse.move(box.x + (col + word.length / 2) * charW, box.y + box.height / 2);
}

const statValues = (page: Page) => page.locator('.summary .value').allTextContents();

test.describe('ABI Explorer', () => {
  test('compiles the default example and reacts to target changes', async ({ page }) => {
    await waitReady(page);
    await expect(page.locator('#clang-version')).toContainText('clang version');
    expect(await statValues(page)).toEqual(['40', '8', '13']);
    await expect(page.locator('.field-table tbody tr[class]').first()).toBeVisible();

    await page.selectOption('#target', 'avr-unknown-unknown');
    await expect.poll(() => statValues(page)).toEqual(['21', '1', '0']);

    await page.selectOption('#target', 'x86_64-pc-windows-msvc');
    await expect.poll(() => statValues(page)).toEqual(['40', '8', '13']);
  });

  test('every member is measured (no estimates) with alignment shown', async ({ page }) => {
    await waitReady(page);
    await expect(page.locator('.estimate-note')).toHaveCount(0);
    const aligns = await page.locator('.field-table tbody tr td:nth-child(6)').allTextContents();
    expect(aligns.slice(0, 6)).toEqual(['1', '4', '1', '8', '1', '8']);
  });

  test('gutter dots, line hover, inlay and type hover popup', async ({ page }) => {
    await waitReady(page);
    await expect(page.locator('.monaco-editor .member-dot')).toHaveCount(6);
    await hoverWord(page, 'uint64_t id;', 'id');
    await expect(page.locator('.field-table tr.hovered .fname')).toHaveText(['id']);
    await expect(page.locator('.monaco-editor .member-inlay')).toHaveText(
      /offset 16 · 8 B · align 8/,
    );
    await expect(page.locator('.abix-tip.rich')).toHaveCount(0); // no grid/table bubble for editor hovers

    // Type documentation popup on the type name (clang-probed).
    await hoverWord(page, 'uint64_t id;', 'uint64_t');
    const hover = page.locator('.monaco-editor .monaco-hover:not(.hidden)');
    await expect(hover).toBeVisible({ timeout: 10_000 });
    await expect(hover).toContainText('uint64_t');
    await expect(hover).toContainText('8');
    await page.mouse.move(5, 5); // leave the (sticky) hover widget first
    await expect(hover).toHaveCount(0);
    await hoverWord(page, 'struct Example {', 'Example');
    await expect(hover).toContainText('struct Example');
    await expect(hover).toContainText('40');
  });

  test('table hover highlights the source line', async ({ page }) => {
    await waitReady(page);
    await page.locator('.field-table tbody tr').nth(3).hover();
    await expect(page.locator('.monaco-editor .member-line-hovered')).toHaveCount(1);
    await expect(page.locator('[role=tooltip]')).toBeVisible();
  });

  test('compound members: nested struct, union, anonymous', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', '2');
    await expect(page.locator('#record-chips .chip')).toHaveCount(3);
    await hoverWord(page, 'struct Header hdr;', 'hdr');
    await expect(page.locator('.field-table tr.hovered .fname')).toHaveText(['kind', 'len']);
    await expect(page.locator('.monaco-editor .member-inlay')).toHaveText(
      /offset 0 · 4 B · align 2/,
    );
    await hoverWord(page, 'union Payload payload;', 'payload');
    await expect(page.locator('.field-table tr.hovered .fname')).toHaveText([
      'raw',
      'word',
      'number',
    ]);
    await hoverWord(page, 'crc_lo, crc_hi', 'crc_lo');
    await expect(page.locator('.field-table tr.hovered .fname')).toHaveText(['crc_lo', 'crc_hi']);
  });

  test('C++: virtual bases on MSVC and Itanium, private members measured', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', '4');
    await expect(page.locator('#record-chips .chip')).toHaveCount(4);
    await expect
      .poll(() => page.locator('.record .title').textContent())
      .toContain('struct Diamond');
    expect(await statValues(page)).toEqual(['32', '8', '4']);
    await expect(page.locator('.field-table .fname', { hasText: 'vtable pointer' })).toHaveCount(2);
    await page.selectOption('#target', 'x86_64-pc-windows-msvc');
    await expect(page.locator('.field-table .fname', { hasText: 'vbtable pointer' })).toHaveCount(
      1,
    );
  });

  test('stacked view shows all records and links hovers across sections', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', '2');
    await page.click('#view-toggle');
    await expect(page.locator('.record')).toHaveCount(3);
    await expect(page.locator('#record-chips')).toBeHidden();
    await hoverWord(page, 'uint16_t kind;', 'kind');
    await expect(page.locator('.field-table tr.hovered')).toHaveCount(2); // Header and Message sections
    await page.reload();
    await expect(page.locator('.record')).toHaveCount(3, { timeout: 120_000 }); // remembered
    await page.click('#view-toggle');
    await expect(page.locator('.record')).toHaveCount(1);
  });

  test('errors: red status, squiggle, then recovers', async ({ page }) => {
    await waitReady(page);
    await page.locator('.monaco-editor .view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nstruct Broken { int x }');
    await expect(page.locator('[role=status].error')).toBeVisible();
    await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(1);
    await page.keyboard.type(';');
    await expect(page.locator('[role=status].ok')).toBeVisible();
    await expect(page.locator('#record-chips .chip')).toHaveCount(2);
  });

  test('share URL round-trips source and options', async ({ page, context }) => {
    await waitReady(page);
    await page.selectOption('#target', 'msp430-none-elf');
    await page.click('input[name=lang][value="c++"] + span');
    await expect.poll(() => statValues(page)).not.toEqual(['40', '8', '13']); // recompiled for msp430/C++
    await page.waitForTimeout(800); // hash sync is debounced
    const url = page.url();
    expect(url).toMatch(/#2\./);
    const page2 = await context.newPage();
    await page2.goto(url);
    await expect(page2.locator('#results')).toBeVisible({ timeout: 120_000 });
    await expect(page2.locator('#target')).toHaveValue('msp430-none-elf');
    await expect(page2.locator('input[name=lang][value="c++"]')).toBeChecked();
    expect(await statValues(page2)).toEqual(await statValues(page));
  });

  test('works offline after the first visit (PWA)', async ({ page, context }) => {
    await waitReady(page);
    await expect(page.locator('#offline-status')).toBeVisible({ timeout: 30_000 });
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#results')).toBeVisible({ timeout: 120_000 });
    await page.selectOption('#target', 'avr-unknown-unknown');
    await expect.poll(() => statValues(page)).toEqual(['21', '1', '0']);
    await context.setOffline(false);
  });
});
