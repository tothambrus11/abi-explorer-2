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

  test('metered connection: the download waits for an explicit opt-in', async ({ page }) => {
    // Pretend the browser reports Data Saver before any app code runs.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        get: () => ({ saveData: true, effectiveType: '4g' }),
      });
    });
    // Watch for the module itself, not just the prompt: the gate is only real
    // if no byte of it is requested before the click.
    let moduleRequests = 0;
    await page.route('**/vendor/abi/**', (route) => {
      moduleRequests++;
      return route.continue();
    });
    await page.goto('/');
    // Nothing is fetched until the user agrees; the results pane stays gated.
    await expect(page.locator('#allow-download')).toBeVisible();
    await expect(page.locator('#consent-text')).toContainText(/~\d+ MB/);
    await expect(page.locator('#results')).toHaveCount(0);
    // Give a stray eager start time to show itself before asserting.
    await page.waitForTimeout(2_000);
    expect(moduleRequests, 'the module was fetched before consent').toBe(0);

    await page.click('#allow-download');
    await expect(page.locator('#allow-download')).toHaveCount(0);
    await expect(page.locator('#results')).toBeVisible({ timeout: 240_000 });

    // The choice is remembered: a second visit on the same metered link goes
    // straight to loading.
    await page.goto('/');
    await expect(page.locator('#allow-download')).toHaveCount(0);
    await expect(page.locator('#results')).toBeVisible({ timeout: 240_000 });
  });

  test('every member is measured, with its alignment shown', async ({ page }) => {
    await waitReady(page);
    const aligns = await page.locator('.field-table tbody tr td:nth-child(6)').allTextContents();
    expect(aligns.slice(0, 6)).toEqual(['1 B', '4 B', '1 B', '8 B', '1 B', '8 B']);
  });

  test('member circles, line hover, inlay and type hover popup', async ({ page }) => {
    await waitReady(page);
    // One circle per member declarator, inline before the member's name.
    await expect(page.locator('.monaco-editor .member-dot')).toHaveCount(6);
    await hoverWord(page, 'uint64_t id;', 'id');
    await expect(page.locator('.field-table tr.hovered .fname')).toHaveText(['id']);
    await expect(page.locator('.monaco-editor .member-inlay')).toHaveText(
      /offset 16 B · 8 B · align 8 B/,
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
    // A named compound member is one unit, so its circle carries one colour —
    // the same colour its nested fields share in the table.
    const hdrDot = page.locator('.monaco-editor .view-line', { hasText: 'struct Header hdr' });
    const hdrColour = await hdrDot
      .locator('.member-dot')
      .evaluate((e) => [...e.classList].find((c) => c.startsWith('member-c-')));
    expect(hdrColour).not.toBe('member-c-compound');
    // An anonymous aggregate spans several members, so it keeps the ring.
    await expect(page.locator('.monaco-editor .member-dot.member-c-compound')).toHaveCount(1);
    // Hovering a compound member in code lights up its parent (group) row plus
    // each of its leaves in the grouped table.
    await hoverWord(page, 'struct Header hdr;', 'hdr');
    await expect(page.locator('.field-table tr.hovered .fname')).toHaveText(['hdr', 'kind', 'len']);
    await expect(page.locator('.monaco-editor .member-inlay')).toHaveText(
      /offset 0 B · 4 B · align 2 B/,
    );
    await hoverWord(page, 'union Payload payload;', 'payload');
    await expect(page.locator('.field-table tr.hovered .fname')).toHaveText([
      'payload',
      'raw',
      'word',
      'number',
    ]);
    // The union parent carries a tag; its children are flagged as overlapping.
    await expect(page.locator('.field-table tr.group.hovered .tag.union')).toBeVisible();
    // Column-precise: on a line declaring several members, the pointer picks
    // exactly one — `crc_lo` alone, not the whole anonymous member…
    await hoverWord(page, 'crc_lo, crc_hi', 'crc_lo');
    await expect(page.locator('.field-table tr.hovered .fname')).toHaveText(['crc_lo']);
    await expect(page.locator('.monaco-editor .member-name-hovered')).toHaveCount(1);
    // …while the anonymous member's own declarator still selects all of it.
    await hoverWord(page, 'crc_lo, crc_hi', 'struct');
    await expect(page.locator('.field-table tr.hovered .fname')).toHaveText([
      '(anonymous)',
      'crc_lo',
      'crc_hi',
    ]);
    // `struct { uint8_t crc_lo, crc_hi; };` declares three things on one line:
    // the anonymous member itself (a compound — neutral ring) and its two
    // fields, each with its own colour. One circle per declarator.
    const multi = page.locator('.monaco-editor .view-line', { hasText: 'crc_lo' });
    await expect(multi.locator('.member-dot')).toHaveCount(3);
    const classes = await multi
      .locator('.member-dot')
      .evaluateAll((els) =>
        els.map((e) => [...e.classList].find((c) => c.startsWith('member-c-'))),
      );
    expect(classes.filter((c) => c === 'member-c-compound')).toHaveLength(1);
    // crc_lo and crc_hi are nameable on the record, so they are distinct members.
    expect(new Set(classes.filter((c) => c !== 'member-c-compound')).size).toBe(2);
  });

  test('chips and the member count follow the record’s own members', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', '2');
    await expect(page.locator('.record .title')).toContainText('Message');

    // The chip marks a member of Message: `hdr` has one, its nested fields do not.
    const hdrRow = page.locator('.field-table tr.group', { hasText: 'hdr' }).first();
    await expect(hdrRow.locator('.chip')).toHaveCount(1);
    const kindRow = page.locator('.field-table tr', { hasText: 'kind' }).first();
    await expect(kindRow.locator('.chip')).toHaveCount(0);
    // An anonymous aggregate spans several members, so it has no chip of its own
    // while the fields it injects each do.
    const anonRow = page.locator('.field-table tr.group', { hasText: '(anonymous)' }).first();
    await expect(anonRow.locator('.chip')).toHaveCount(0);
    await expect(
      page.locator('.field-table tr', { hasText: 'crc_lo' }).first().locator('.chip'),
    ).toHaveCount(1);

    // The type popup counts members, not leaves: hdr, payload, crc_lo, crc_hi —
    // four, though eight fields end up in the layout.
    await hoverWord(page, 'struct Message {', 'Message');
    const hover = page.locator('.monaco-editor .monaco-hover:not(.hidden)');
    await expect(hover).toBeVisible({ timeout: 10_000 });
    await expect(hover).toContainText('4 members');
  });

  test('grouped table: hovering a parent row and collapsing it', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', '2');
    const hdr = page.locator('.field-table tr.group', { hasText: 'hdr' }).first();
    // Hovering the parent row highlights its declaration line in the editor and
    // shows the group tooltip.
    await hdr.hover();
    await expect(page.locator('.monaco-editor .member-line-hovered')).toHaveCount(1);
    await expect(page.locator('[role=tooltip]')).toBeVisible();
    // Collapsing the parent hides its leaf rows.
    await expect(page.locator('.field-table tr.hovered .fname')).toHaveText(['hdr', 'kind', 'len']);
    await hdr.locator('.twist').click();
    await expect(page.locator('.field-table .fname', { hasText: 'kind' })).toHaveCount(0);
    await hdr.locator('.twist').click();
    await expect(page.locator('.field-table .fname', { hasText: 'kind' })).toHaveCount(1);
  });

  test('drilling: a compound member opens its own record', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', '2');
    await expect(page.locator('.record .title')).toContainText('Message');

    // Clicking the `hdr` row inspects struct Header, and the caret follows.
    await page.locator('.field-table tr.group .open', { hasText: 'hdr' }).first().click();
    await expect(page.locator('.record .title')).toContainText('Header');
    await expect(
      page.locator('#record-chips .chip', { hasText: 'Header' }).first(),
    ).toHaveAttribute('aria-selected', 'true');
    // Header's own fields are now the top-level members, each with a circle.
    await expect(page.locator('.field-table .fname')).toHaveText(['kind', 'len']);

    // An anonymous member has no name to write, but is still inspectable: it is
    // shown even though it is not listed as a record of its own.
    await page.selectOption('#example', '2');
    await expect(page.locator('.record .title')).toContainText('Message');
    await page.locator('.field-table tr.group .open', { hasText: '(anonymous)' }).first().click();
    await expect(page.locator('.field-table .fname')).toHaveText(['crc_lo', 'crc_hi']);
  });

  // Issue #3: an explicit tab pick must not be undone by the cursor rule.
  test('picking a record from the tabs moves the caret to its declaration', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', '2');
    await expect(page.locator('#record-chips .chip')).toHaveCount(3);

    // Pick Header — not the default selection (the last record is).
    const header = page.locator('#record-chips .chip', { hasText: 'Header' }).first();
    await header.click();
    await expect(header).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.record .title')).toContainText('Header');

    // The caret really moved into Header's declaration: monaco marks the
    // current line's gutter number as active.
    const declLine = await page.evaluate(() => {
      // Monaco positions view-lines absolutely, so DOM order is not source
      // order — sort by offset to recover the line numbering.
      const lines = [...document.querySelectorAll('.monaco-editor .view-line')]
        .map((e) => ({
          top: parseFloat((e as HTMLElement).style.top || '0'),
          text: e.textContent.replace(/\u00a0/g, ' '),
        }))
        .sort((a, b) => a.top - b.top);
      return String(lines.findIndex((l) => l.text.includes('struct Header')) + 1);
    });
    await expect(page.locator('.monaco-editor .active-line-number')).toHaveText(declLine);

    // And the pick sticks: it is the cursor's record now, so it survives the
    // record-follows-cursor rule instead of being reverted by it.
    await expect(header).toHaveAttribute('aria-selected', 'true');
  });

  test('the cursor selects the record it sits in, even where no member is declared', async ({
    page,
  }) => {
    await waitReady(page);
    await page.selectOption('#example', '2');
    await expect(page.locator('#record-chips .chip')).toHaveCount(3, { timeout: 60_000 });
    await expect(page.locator('.record .title')).toContainText('Message');

    // The opening line of `union Payload {` declares no member, so the per-line
    // member index knows nothing about it — the declaration's span does.
    await hoverWord(page, 'union Payload {', 'union');
    await expect(page.locator('.record .title')).toContainText('Payload');

    // And the closing brace of a record is still inside it.
    await hoverWord(page, 'struct Header {', 'struct');
    await expect(page.locator('.record .title')).toContainText('Header');
  });

  test('sizes say what they mean: sizeof vs bytes occupied here', async ({ page }) => {
    await waitReady(page);
    // The record summary names the C++ operators rather than vague words.
    await expect(page.locator('.summary .label').first()).toHaveText('sizeof');
    await expect(page.locator('.summary .label').nth(1)).toHaveText('alignof');

    await page.selectOption('#example', '6'); // virtual inheritance (diamond)
    await expect(page.locator('#record-chips .chip')).toHaveCount(4, { timeout: 60_000 });
    await page.locator('#record-chips .chip', { hasText: 'struct D ' }).click();
    await expect(page.locator('.record .title')).toContainText('struct D');

    // Every base of D occupies less than sizeof(its type) — B and C lose the
    // shared A, and the virtual A itself is placed at its non-virtual size — so
    // all three size cells are marked and explain themselves.
    const noted = page.locator('.field-table .num.noted');
    await expect(noted).toHaveCount(3);
    await expect(noted.first()).toContainText('*');
    // Re-query after the layout has settled: an in-flight analysis re-renders
    // the table and would detach the node mid-hover.
    await expect(page.locator('.status.running')).toHaveCount(0);
    await noted.first().hover({ force: true });
    await expect(page.locator('[role=tooltip]')).toContainText('sizeof');
  });

  test('the byte grid brackets what a base subobject contributes', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', '4');
    await expect
      .poll(() => page.locator('.record .title').textContent())
      .toContain('struct Diamond');
    // Diamond is 32 B; the virtual Base occupies bytes 16..27 (its vtable
    // pointer and `x`), so exactly those bytes are banded — the derived
    // class's own fields sit outside.
    const banded = page.locator('.grid .cell.band');
    await expect(banded).toHaveCount(12);
    await expect(page.locator('.grid .cell.band-first')).toHaveCount(1);
    await expect(page.locator('.grid .cell.band-last')).toHaveCount(1);
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

  test('the standard library resolves on every kind of target, and says how', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', '9'); // C++ standard library (libc++)
    await expect.poll(() => statValues(page)).toEqual(['72', '8', '0']);
    // musl's own tree on Linux, and the footer says so.
    await expect(page.locator('#header-config')).toContainText('libc++ · musl (x86_64)');

    // A target musl has no headers for: it still resolves, over this target's
    // own scalar types, and the footer says which layer answered.
    await page.selectOption('#target', 'aarch64-apple-macosx');
    await expect(page.locator('#header-config')).toContainText('libc++ · musl (portable)');
    await expect(page.locator('#results')).toBeVisible();
    await expect(page.locator('.record .title')).toContainText('Probe');

    // …including Windows, where nothing of the MSVC runtime is shipped.
    await page.selectOption('#target', 'x86_64-pc-windows-msvc');
    await expect(page.locator('#header-config')).toContainText('musl (portable)');
    await expect(page.locator('.record .title')).toContainText('Probe');
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
