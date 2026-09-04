import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

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

/**
 * Opens every collapsible row.
 *
 * The table starts collapsed: a record's own members are what it is, and what
 * is inside one of them is a question the reader asks by opening it. Tests
 * about what is *inside* a member ask first.
 */
async function expandAll(page: Page): Promise<void> {
  // The table has to exist first: called straight after picking an example, it
  // would otherwise find nothing collapsed because nothing is drawn yet, and
  // silently expand none of it.
  await expect(page.locator('.field-table tbody tr').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.field-table [aria-expanded]').first()).toBeVisible({
    timeout: 60_000,
  });

  const collapsed = page.locator('.field-table [aria-expanded="false"]');
  // Expanding reveals more to expand, so this runs until there is nothing
  // left. A pass at a time rather than one click at a time: libc++'s probe
  // nests several levels and each level is many rows.
  for (let pass = 0; pass < 40; pass++) {
    const n = await collapsed.count();
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      // Always the first: each click removes one from the set.
      await collapsed.first().click();
    }
  }
  throw new Error('the table never finished expanding');
}

const ABI_DIST = path.join(process.cwd(), 'dist', 'vendor', 'abi');

/** What the module cache holds, by file name. */
const moduleCache = (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    const cache = await caches.open('abix-abi-module-v1');
    return (await cache.keys()).map((r) => new URL(r.url).pathname.split('/').pop()!);
  });

interface Manifest {
  files: Record<string, { path: string; bytes: number; transferBytes?: number }>;
}

const abiManifest = async (): Promise<Manifest> =>
  JSON.parse(await readFile(path.join(ABI_DIST, 'manifest.json'), 'utf8')) as Manifest;

test.describe('ABI Explorer', () => {
  test('compiles the default example and reacts to target changes', async ({ page }) => {
    await waitReady(page);
    await expect(page.locator('#info-panel')).toBeHidden();
    await page.hover('#info-button');
    await expect(page.locator('#compiler-version')).toContainText('clang version');
    expect(await statValues(page)).toEqual(['40', '8', '13']);
    await expect(page.locator('.field-table tbody tr[class]').first()).toBeVisible();

    await page.selectOption('#target', 'avr-unknown-unknown');
    await expect.poll(() => statValues(page)).toEqual(['21', '1', '0']);

    await page.selectOption('#target', 'x86_64-pc-windows-msvc');
    await expect.poll(() => statValues(page)).toEqual(['40', '8', '13']);
  });

  test('the download reports what it is actually doing', async ({ page, context }) => {
    // The loading screen used to read "0% of 0 MB" for as long as the module
    // took, because nothing reported anything and the client had only its own
    // initial guess to show. The worker streams the two big files itself now,
    // so there are real numbers, and they land in the Cache API on the way
    // past, which is what makes an interrupted first visit leave something
    // behind rather than nothing.
    //
    // Throttled on purpose: over localhost the whole thing arrives inside one
    // animation frame and there is nothing to observe.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 5,
      downloadThroughput: 12 * 1024 * 1024,
      uploadThroughput: -1,
    });

    interface Sample {
      state: string;
      phase?: string;
      done?: number;
      total?: number;
    }
    await page.addInitScript(() => {
      const w = window as unknown as {
        __seen: Sample[];
        __abix?: { store?: { compiler: Sample } };
      };
      w.__seen = [];
      const tick = () => {
        const c = w.__abix?.store?.compiler;
        if (c) w.__seen.push({ ...c });
        if (c?.state !== 'ready') requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto('/');
    await expect(page.locator('#results')).toBeVisible({ timeout: 240_000 });

    const seen = await page.evaluate(() => (window as unknown as { __seen: Sample[] }).__seen);
    const downloads = seen.filter((x) => x.state === 'loading' && x.phase === 'download');
    expect(downloads.length, 'the download was reported at all').toBeGreaterThan(1);
    // A real size, from the module's own manifest, and it moves.
    const last = downloads.at(-1)!;
    expect(last.total).toBeGreaterThan(1_000_000);
    expect(last.done).toBeGreaterThan(downloads[0]!.done!);
    expect(last.done).toBeLessThanOrEqual(last.total!);
    expect(
      seen.some((x) => x.phase === 'compile'),
      'and then it says it is preparing clang',
    ).toBe(true);

    // The bytes are in the cache before the module is even instantiated, so a
    // visit abandoned during the download still leaves the next one offline.
    // Under the names the manifest gives them, which the build derives from
    // their content: that is what lets a later release land at all.
    const cached = await page.evaluate(async () => {
      const manifest = (await (await fetch('vendor/abi/manifest.json')).json()) as {
        files: Record<string, { path: string }>;
      };
      const cache = await caches.open('abix-abi-module-v1');
      const keys = new Set((await cache.keys()).map((r) => new URL(r.url).pathname));
      return ['wasm', 'headers', 'glue'].map((key) => ({
        key,
        path: manifest.files[key]!.path,
        cached: keys.has(
          new URL(`vendor/abi/${manifest.files[key]!.path}`, location.href).pathname,
        ),
      }));
    });
    expect(
      cached.every((f) => f.cached),
      `not all cached: ${JSON.stringify(cached)}`,
    ).toBe(true);
    expect(cached.map((f) => f.path).every((p) => /-[0-9a-f]{12}\./.test(p))).toBe(true);
  });

  test('the gzip the site is deployed with is undone here, and counted honestly', async ({
    page,
  }) => {
    // The build gzips the two big files and gives them `.gz` names. Whether
    // they arrive compressed is up to the host: Vite's preview server sets
    // `Content-Encoding: gzip` and the browser has undone it before the worker
    // sees a byte, while Cloudflare Pages (where this deploys) hands over
    // the gzip stream for the worker to undo. Every other test in this file
    // runs the first path. This one runs the one production takes.
    const dist = path.join(process.cwd(), 'dist');
    await page.route('**/vendor/abi/*.gz', async (route) => {
      const body = await readFile(path.join(dist, new URL(route.request().url()).pathname));
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body,
      });
    });

    interface Sample {
      state: string;
      phase?: string;
      done?: number;
      total?: number;
    }
    await page.addInitScript(() => {
      const w = window as unknown as {
        __seen: Sample[];
        __abix?: { store?: { compiler: Sample } };
      };
      w.__seen = [];
      const tick = () => {
        const c = w.__abix?.store?.compiler;
        if (c) w.__seen.push({ ...c });
        if (c?.state !== 'ready') requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await page.goto('/');
    // It answers at all: the bytes that came out of the decompressor really
    // were a wasm module and a header pack.
    await expect(page.locator('#results')).toBeVisible({ timeout: 240_000 });
    expect(await statValues(page)).toEqual(['40', '8', '13']);

    // And the bar counted what the connection spent, not what it expanded to.
    // Those differ by a factor of four here, and quoting one under the other
    // is how a "~11 MB" prompt came to sit in front of a bar counting to 47.
    const manifest = JSON.parse(
      await readFile(path.join(dist, 'vendor', 'abi', 'manifest.json'), 'utf8'),
    ) as { files: Record<string, { bytes: number; transferBytes?: number }> };
    const wire = ['wasm', 'headers'].reduce(
      (n, key) => n + (manifest.files[key]!.transferBytes ?? manifest.files[key]!.bytes),
      0,
    );
    const seen = await page.evaluate(() => (window as unknown as { __seen: Sample[] }).__seen);
    const downloads = seen.filter((x) => x.state === 'loading' && x.phase === 'download');
    expect(downloads.at(-1)!.total).toBe(wire);
    expect(downloads.at(-1)!.done).toBe(wire);
  });

  test('a new release reaches a visitor who already has the old one', async ({ page, context }) => {
    // The reason every file is named after its content. This directory is
    // served `immutable` and cached `CacheFirst`, so under stable names a new
    // module is one no returning visitor would ever fetch: they would keep
    // whatever they downloaded the first time, forever, and there would be no
    // way to find out short of asking them.
    await waitReady(page);
    const first = await moduleCache(page);
    expect(first.length).toBeGreaterThan(1);

    // Publish one: the same bytes under different names, which is what a
    // rebuilt module looks like from the browser's side.
    const manifest = await abiManifest();
    const next = { ...manifest, files: { ...manifest.files } };
    for (const [key, file] of Object.entries(manifest.files)) {
      next.files[key] = { ...file, path: `next-${file.path}` };
    }
    // `context`, not `page`: on the second visit the service worker is
    // controlling, and its fetches are what actually go to the network.
    await context.route('**/vendor/abi/manifest.json', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(next) }),
    );
    const asked = new Set<string>();
    await context.route('**/vendor/abi/next-*', async (route) => {
      const name = path.basename(new URL(route.request().url()).pathname).replace(/^next-/, '');
      asked.add(name);
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: await readFile(path.join(ABI_DIST, name)),
      });
    });

    await page.reload();
    await expect(page.locator('#results')).toBeVisible({ timeout: 240_000 });
    expect(await statValues(page)).toEqual(['40', '8', '13']);
    // It went and got the new one rather than answering from what it had.
    expect([...asked].sort()).toEqual(
      Object.values(manifest.files)
        .map((f) => f.path)
        .sort(),
    );

    // And let go of what it replaced, otherwise every upgrade would leave
    // another 11 MB behind in the user's storage quota.
    const after = await moduleCache(page);
    expect(after.filter((f) => !f.startsWith('next-') && f !== 'manifest.json')).toEqual([]);
  });

  test('what the reader opened stays open while they type', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', { label: 'Union + nested' });
    await expandAll(page);
    const kind = page.locator('.field-table .fname', { hasText: 'kind' });
    await expect(kind).toHaveCount(1);

    // Every compile builds fresh models. Holding the opened rows against the
    // model object shut all of them on the next keystroke, which is most of
    // them, most of the time.
    await page.locator('.monaco-editor').click();
    await page.keyboard.press('End');
    await page.keyboard.type('\n');
    await expect.poll(() => kind.count(), { timeout: 30_000 }).toBe(1);
  });

  test('a member hovered inside a shut row still lights it', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', { label: 'Union + nested' });
    // Shut to begin with, so the row that would carry the highlight is the
    // group, not the member: hovering the member in the editor must light
    // something, or the table looks broken.
    await expect(page.locator('.field-table .fname', { hasText: 'kind' })).toHaveCount(0);
    await hoverWord(page, 'uint16_t kind;', 'kind');
    await expect(page.locator('.field-table tr.hovered .gname')).toHaveText(['hdr']);
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
      // Not the manifest: 400 bytes, and it is where the figure in the prompt
      // comes from. The gate exists to protect a data allowance, so what it
      // has to hold back is the module.
      if (!route.request().url().endsWith('/manifest.json')) moduleRequests++;
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
    await page.selectOption('#example', { label: 'Union + nested' });
    await expandAll(page);
    await expect(page.locator('#record-chips .chip')).toHaveCount(3);
    // A named compound member is one unit, so its circle carries one colour,
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
    // exactly one: `crc_lo` alone, not the whole anonymous member…
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
    // the anonymous member itself (a compound, neutral ring) and its two
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
    await page.selectOption('#example', { label: 'Union + nested' });
    await expandAll(page);
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

    // The type popup counts members, not leaves: hdr, payload, crc_lo, crc_hi:
    // four, though eight fields end up in the layout.
    await hoverWord(page, 'struct Message {', 'Message');
    const hover = page.locator('.monaco-editor .monaco-hover:not(.hidden)');
    await expect(hover).toBeVisible({ timeout: 10_000 });
    await expect(hover).toContainText('4 members');
  });

  test('grouped table: hovering a parent row and collapsing it', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', { label: 'Union + nested' });
    const hdr = page.locator('.field-table tr.group', { hasText: 'hdr' }).first();
    // Hovering the parent row highlights its declaration line in the editor and
    // shows the group tooltip.
    await hdr.hover();
    await expect(page.locator('.monaco-editor .member-line-hovered')).toHaveCount(1);
    await expect(page.locator('[role=tooltip]')).toBeVisible();

    // Collapsed to begin with, so what a group holds is hidden until asked for.
    await expect(page.locator('.field-table .fname', { hasText: 'kind' })).toHaveCount(0);
    await hdr.locator('.twist').click();
    await expect(page.locator('.field-table .fname', { hasText: 'kind' })).toHaveCount(1);
    // Hovering the parent still lights every leaf it holds, now that they show.
    await hdr.hover();
    await expect(page.locator('.field-table tr.hovered .fname')).toHaveText(['hdr', 'kind', 'len']);
    // And collapsing it hides them again.
    await hdr.locator('.twist').click();
    await expect(page.locator('.field-table .fname', { hasText: 'kind' })).toHaveCount(0);
  });

  test('drilling: a compound member opens its own record', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', { label: 'Union + nested' });
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
    await page.selectOption('#example', { label: 'Union + nested' });
    await expect(page.locator('.record .title')).toContainText('Message');
    await page.locator('.field-table tr.group .open', { hasText: '(anonymous)' }).first().click();
    await expect(page.locator('.field-table .fname')).toHaveText(['crc_lo', 'crc_hi']);
  });

  // Issue #3: an explicit tab pick must not be undone by the cursor rule.
  test('picking a record from the tabs moves the caret to its declaration', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', { label: 'Union + nested' });
    await expect(page.locator('#record-chips .chip')).toHaveCount(3);

    // Pick Header, not the default selection (the last record is).
    const header = page.locator('#record-chips .chip', { hasText: 'Header' }).first();
    await header.click();
    await expect(header).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.record .title')).toContainText('Header');

    // The caret really moved into Header's declaration: monaco marks the
    // current line's gutter number as active.
    const declLine = await page.evaluate(() => {
      // Monaco positions view-lines absolutely, so DOM order is not source
      // order: sort by offset to recover the line numbering.
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
    await page.selectOption('#example', { label: 'Union + nested' });
    await expect(page.locator('#record-chips .chip')).toHaveCount(3, { timeout: 60_000 });
    await expect(page.locator('.record .title')).toContainText('Message');

    // The opening line of `union Payload {` declares no member, so the per-line
    // member index knows nothing about it; the declaration's span does.
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

    await page.selectOption('#example', { label: 'Virtual inheritance (diamond)' });
    await expect(page.locator('#record-chips .chip')).toHaveCount(4, { timeout: 60_000 });
    await page.locator('#record-chips .chip', { hasText: 'struct D ' }).click();
    await expect(page.locator('.record .title')).toContainText('struct D');

    // Every base of D occupies less than sizeof(its type): B and C lose the
    // shared A, and the virtual A itself is placed at its non-virtual size, so
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

  test('hovering a base lights exactly the bytes it occupies', async ({ page }) => {
    // The thing the whole model is for. A virtual base is placed by the most
    // derived object, after the fields declared before it, and it occupies its
    // non-virtual size rather than its sizeof, none of which is recoverable
    // from a list of offsets, and all of which decides which bytes light up.
    await waitReady(page);
    await page.selectOption('#example', { label: 'Virtual inheritance (diamond)' });
    await expect.poll(() => page.locator('.record .title').textContent()).toContain('struct D');

    await page.locator('.field-table tr.group', { hasText: 'virtual A' }).first().hover();
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll('.grid .cell')]
            .map((c, i) => (c.classList.contains('hovered') ? i : -1))
            .filter((i) => i >= 0),
        ),
      )
      // A at offset 32, occupying 12 bytes: its vtable pointer and its int.
      .toEqual([32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43]);

    // …and the editor marks the base specifier, whose source range no clang
    // dump format emits.
    await expect(page.locator('.monaco-editor .member-name-hovered')).toHaveCount(1);
  });

  test('hovering a shared byte in the grid highlights every member sharing it', async ({
    page,
  }) => {
    // The DOM end of the grid-to-table law: a striped union cell stands for
    // all of its members at once, so hovering it must light each of their
    // rows (and their parent, whose leaves are then all hovered), not just
    // whichever member the stripe happens to paint first.
    await waitReady(page);
    await page.selectOption('#example', { label: 'Union + nested' });
    await expandAll(page);
    await expect
      .poll(() => page.locator('.record .title').textContent())
      .toContain('struct Message');
    await expect(page.locator('.status.running')).toHaveCount(0);
    await page.locator('.grid .cell.multi').first().hover();
    await expect(page.locator('.field-table tr.hovered .fname')).toHaveText([
      'payload',
      'raw',
      'word',
      'number',
    ]);
    // The bubble names them all too.
    const tip = page.locator('.abix-tip.rich');
    await expect(tip).toContainText('raw');
    await expect(tip).toContainText('word');
    await expect(tip).toContainText('number');
  });

  test('the byte grid brackets what a base subobject contributes', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', { label: 'Virtual & bases' });
    await expect
      .poll(() => page.locator('.record .title').textContent())
      .toContain('struct Diamond');
    // Diamond is 32 B; the virtual Base occupies bytes 16..27 (its vtable
    // pointer and `x`), so exactly those bytes are banded: the derived
    // class's own fields sit outside.
    const banded = page.locator('.grid .cell.band');
    await expect(banded).toHaveCount(12);
    await expect(page.locator('.grid .cell.band-first')).toHaveCount(1);
    await expect(page.locator('.grid .cell.band-last')).toHaveCount(1);
  });

  test('C++: virtual bases on MSVC and Itanium, private members measured', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', { label: 'Virtual & bases' });
    await expandAll(page);
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

  test('drilling into a library type shows the layout it actually has', async ({ page }) => {
    // The record is libc++'s, not the user's, so it is not listed as a tab:
    // it is reached by its id from the member that uses it. Nothing in the app
    // matches a printed type name to find it, which is the point.
    await waitReady(page);
    await page.selectOption('#example', { label: 'Using standard library (libc++)' });
    await expect(page.locator('.record .title')).toContainText('Probe');
    await expect(page.locator('#record-chips .chip')).toHaveCount(1);

    await page.locator('.field-table tr.group', { hasText: 's' }).first().locator('.gname').click();
    await expect(page.locator('.record .title')).toContainText('std::string');
    // And it is a real layout, not a stub: three pointers on this target.
    expect((await statValues(page))[0]).toBe('24');
  });

  test('a row whose type wraps is highlighted whole, guides and all', async ({ page }) => {
    // libc++'s anonymous structs print as `struct (anonymous at /usr/include/
    // c++/v1/string:884:5)`, which wraps the type column, and the name cell
    // used to be a flex box rather than a table cell: one line tall, with the
    // page showing through below it when the row was hovered, and the
    // hovered colour wiping the nesting guides besides.
    await waitReady(page);
    await page.selectOption('#example', { label: 'Using standard library (libc++)' });
    await expect(page.locator('.record .title')).toContainText('Probe');
    // Probe::s → basic_string's __rep_ → the union's __l member. Names are
    // matched whole, `s` being a substring of most of them. Each record is
    // opened first: `__rep_` sits inside an anonymous group, and a table that
    // starts collapsed has not drawn it yet.
    for (const name of ['s', '__rep_', '__l']) {
      await expandAll(page);
      await page
        .locator('.field-table tr.group .gname', { hasText: new RegExp(`^${name}$`) })
        .first()
        .click();
    }
    await expect(page.locator('.record .title')).toContainText('__long');
    const row = page.locator('.field-table tr.group', { hasText: '(anonymous)' }).first();
    const rowBox = (await row.boundingBox())!;
    const typeBox = (await row.locator('td.type').boundingBox())!;
    expect(typeBox.height, 'the type wraps, or this test checks nothing').toBeGreaterThan(30);
    await row.hover();
    await expect(row).toHaveClass(/hovered/);
    const name = row.locator('td.name');
    const nameBox = (await name.boundingBox())!;
    // The cell spans the row, so the hover colour reaches the bottom…
    expect(Math.abs(nameBox.height - rowBox.height)).toBeLessThan(2);
    // …and the guides are still drawn under the colour.
    await expect(name).toHaveCSS('background-image', /repeating-linear-gradient/);
  });

  test('the standard library resolves on every kind of target, and says how', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', { label: 'Using standard library (libc++)' });
    await expect.poll(() => statValues(page)).toEqual(['72', '8', '0']);
    // musl's own tree on Linux, and the details say so.
    await page.hover('#info-button');
    await expect(page.locator('#header-config')).toContainText('libc++ · musl (x86_64)');

    // A target musl has no headers for: it still resolves, over this target's
    // own scalar types, and the details say which layer answered.
    await page.selectOption('#target', 'aarch64-apple-macosx');
    await page.hover('#info-button');
    await expect(page.locator('#header-config')).toContainText('libc++ · musl (portable)');
    await expect(page.locator('#results')).toBeVisible();
    await expect(page.locator('.record .title')).toContainText('Probe');

    // …including Windows, where nothing of the MSVC runtime is shipped.
    await page.selectOption('#target', 'x86_64-pc-windows-msvc');
    await page.hover('#info-button');
    await expect(page.locator('#header-config')).toContainText('musl (portable)');
    await expect(page.locator('.record .title')).toContainText('Probe');
  });

  test('each template instantiation answers for itself', async ({ page }) => {
    // `Pair<double>` and `Pair<char>` are two records with two sizes, and an
    // editor's idea of a word stops at `<`, so both hovers asked about
    // `Pair`, and the index, which knew that spelling only as the first
    // instantiation to register it, answered `Pair<double>` twice.
    await waitReady(page);
    await page.selectOption('#example', { label: 'Template instantiation' });
    await expect.poll(() => page.locator('#record-chips .chip').count()).toBeGreaterThan(1);
    const hover = page.locator('.monaco-editor .monaco-hover:not(.hidden)');

    await hoverWord(page, 'Pair<double> pd;', 'Pair');
    await expect(hover).toBeVisible({ timeout: 10_000 });
    await expect(hover).toContainText('Pair<double>');
    await expect(hover, 'sizeof(Pair<double>)').toContainText('16');
    await page.mouse.move(5, 5); // leave the sticky hover widget
    await expect(hover).toHaveCount(0);

    await hoverWord(page, 'Pair<char>', 'Pair');
    await expect(hover).toBeVisible({ timeout: 10_000 });
    await expect(hover).toContainText('Pair<char>');
    await expect(hover, 'sizeof(Pair<char>)').toContainText('2');
    await expect(hover, 'answered for the other instantiation').not.toContainText('Pair<double>');
  });

  test('the tree says what is nested in what', async ({ page }) => {
    // Siblings line up, whatever they are. A group writes its twisty and its
    // name with a newline between them and a leaf writes them adjacent, so a
    // collapsible row's name sat one collapsed space right of its own
    // siblings', and with no guide lines to fall back on, a leaf beside a
    // collapsible sibling read as its child.
    await waitReady(page);
    await page.selectOption('#example', { label: 'Using standard library (libc++)' });
    await expandAll(page);
    await expect
      .poll(() => page.locator('.record .title').textContent(), { timeout: 120_000 })
      .toContain('Probe');

    const byDepth = await page.evaluate(() => {
      const out = new Map<string, { x: number; name: string; guides: number }[]>();
      for (const cell of document.querySelectorAll<HTMLElement>('.field-table td.name')) {
        const depth = cell.style.getPropertyValue('--depth').trim();
        const name = cell.querySelector('.fname');
        if (!depth || !name) continue;
        const list = out.get(depth) ?? [];
        out.set(depth, list);
        list.push({
          // Rounded: sub-pixel text metrics are not what this is about.
          x: Math.round(name.getBoundingClientRect().left),
          name: name.textContent,
          // One vertical guide per ancestor, drawn as a background on the cell.
          guides: Number(
            /\/\s*(\d+(?:\.\d+)?)px/.exec(getComputedStyle(cell).background)?.[1] ?? 0,
          ),
        });
      }
      return [...out.entries()];
    });

    const depths = byDepth.map(([d]) => d);
    expect(depths.length, 'the libc++ probe nests several levels deep').toBeGreaterThan(3);
    for (const [depth, rows] of byDepth) {
      const xs = [...new Set(rows.map((r) => r.x))];
      expect(
        xs,
        `depth ${depth} does not line up: ${rows.map((r) => `${r.name}@${r.x}`).join(', ')}`,
      ).toHaveLength(1);
      // …and each row is fenced by one guide per level above it, so the depth
      // is readable without counting pixels.
      for (const r of rows) {
        expect(r.guides, `${r.name} at depth ${depth}`).toBe(Number(depth) * 16);
      }
    }
  });

  test('hovering a byte inside a base actually looks different', async ({ page }) => {
    // Not "is the class applied"; it always was. The base-subobject band
    // draws its bracket with a `box-shadow` on `.cell.band`, two classes to
    // `.hovered`'s one, so on every byte inside a base the band won the
    // property outright and hovering an inherited member changed nothing on
    // screen. Both signals are real and want the same edge; the only way to
    // catch one silently eating the other is to compare what is rendered.
    await waitReady(page);
    await page.selectOption('#example', { label: 'Virtual inheritance (diamond)' });
    await expandAll(page);
    await expect.poll(() => page.locator('#record-chips .chip').count()).toBeGreaterThan(3);
    await page.locator('#record-chips .chip', { hasText: 'struct D' }).click();
    await expect(page.locator('.field-table tbody tr')).toHaveCount(10);

    // Byte 8 is `b`, inside base B's band.
    const cell = page.locator('.grid .cell').nth(8);
    const paint = () =>
      cell.evaluate((el) => {
        const s = getComputedStyle(el);
        return `${s.boxShadow} | ${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}`;
      });
    const rows = page.locator('.field-table tbody tr');
    await expect(cell).toHaveClass(/band/);

    // Two hovers rather than a hover against a resting state: selecting the
    // record puts the caret on `struct D : B, C`, and a caret on a line
    // highlights what that line declares, so byte 8 starts out lit.
    await rows.nth(9).hover(); // `a`, at byte 40, nothing to do with byte 8
    await expect(rows.nth(9)).toContainText('a');
    await expect(cell).not.toHaveClass(/hovered/);
    const idle = await paint();

    await rows.nth(2).hover(); // `b`, at byte 8
    await expect(rows.nth(2)).toContainText('b');
    await expect(cell).toHaveClass(/hovered/);
    expect(await paint(), 'the hover is invisible under the band').not.toBe(idle);
  });

  test('inherited members get colours of their own, and the base still gathers them', async ({
    page,
  }) => {
    // A record with three bases and three vtable pointers. An inherited member
    // is nameable on the derived object: `d.b`, with nothing written in
    // between, so it is a member of D in its own right and gets its own
    // colour, exactly like the field D declares itself. The base is a
    // container in the layout and not in the language: it gathers them, and
    // has no colour of its own because its bytes have several.
    await waitReady(page);
    await page.selectOption('#example', { label: 'Virtual inheritance (diamond)' });
    await expandAll(page);
    await expect.poll(() => page.locator('#record-chips .chip').count()).toBeGreaterThan(3);
    await page.locator('#record-chips .chip', { hasText: 'struct D' }).click();
    await expect(page.locator('.field-table tbody tr')).toHaveCount(10);

    const bytes = (t: string | null) => Number(/(-?\d+)\s*B/.exec(t ?? '')?.[1] ?? NaN);
    const litNow = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.grid .cell')]
          .map((c, b) => (c.classList.contains('hovered') ? b : -1))
          .filter((b) => b >= 0),
      );

    const rows = page.locator('.field-table tbody tr');
    const chipOf = new Map<string, string>();
    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      const name = (await row.locator('td.name').textContent())?.trim() ?? '';
      const at = bytes(await row.locator('td').nth(3).textContent());
      const size = bytes(await row.locator('td').nth(4).textContent());
      await row.hover();
      // Exactly its own bytes, a base row included, which is what gathering
      // its members means.
      expect(await litNow(), `${name} (@${at}, ${size} B)`).toEqual(
        Array.from({ length: size }, (_, k) => at + k),
      );
      const chip = row.locator('td.chip-col .chip');
      // The class also carries Svelte's scope hash.
      const cls = (await chip.count()) ? ((await chip.getAttribute('class')) ?? '') : '';
      chipOf.set(name, /\bc-[\w-]+/.exec(cls)?.[0] ?? '');
    }

    // Four members, four colours: `d`, and the three it inherits.
    const members = ['b', 'c', 'd', 'a'].map((n) => chipOf.get(n));
    expect(new Set(members).size, `inherited members share a colour: ${members.join()}`).toBe(4);
    expect(members.every((c) => c && c !== 'c-special')).toBe(true);
    // The vtable pointers keep the category they share.
    expect(chipOf.get('B vtable pointer')).toBe('c-special');
    // The bases carry none: their bytes are several colours now.
    expect(chipOf.get('▾ B base')).toBe('');
    expect(chipOf.get('▾ virtual A base')).toBe('');

    // The gutter agrees with the grid *for the record on screen*. `b` is
    // declared inside `struct B`, and B numbers its own members from scratch:
    // the dot has to be D's colour for it, not B's.
    const dots = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('.view-line')];
      return [...document.querySelectorAll('[class*="member-dot"]')].map((d) => ({
        colour: /member-(c-[\w-]+)/.exec(d.className)?.[1] ?? '',
        // Monaco renders spaces as U+00A0, so `startsWith` needs the real ones.
        line: (lines.find((l) => l.contains(d))?.textContent ?? '').replace(/\u00a0/g, ' ').trim(),
      }));
    });
    for (const [name, decl] of [
      ['b', 'struct B :'],
      ['c', 'struct C :'],
      ['d', 'struct D :'],
      ['a', 'struct A {'],
    ] as const) {
      const on = dots.filter((d) => d.line.startsWith(decl) && d.colour !== 'c-compound');
      expect(
        on.map((d) => d.colour),
        `dot on ${decl} for ${name}`,
      ).toEqual([chipOf.get(name)]);
    }
    // A base clause introduces several colours, so it gets the neutral ring.
    expect(dots.filter((d) => d.colour === 'c-compound').length).toBe(3);

    // Hovering the base where the inheritance is *written* gathers its
    // members in the grid, the same as hovering its row.
    await hoverWord(page, 'struct D', 'B');
    expect(await litNow(), 'hovering `: B` lights B’s bytes').toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  test('stacked view shows all records and links hovers across sections', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#example', { label: 'Union + nested' });
    await page.click('#view-toggle');
    await expect(page.locator('.record')).toHaveCount(3);
    // After the switch: stacking draws a table per record, and each of them
    // starts collapsed.
    await expandAll(page);
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

  test('an unknown triple says so instead of showing an empty panel', async ({ page }) => {
    // A triple is free text, so this is a thing users do. The failure has no
    // source location (it happens before a line of the file is read), so it
    // reaches the editor as no squiggle at all, and the diagnostics panel is
    // the only place it can appear.
    await waitReady(page);
    await page.selectOption('#target', '__custom__');
    await page.fill('#custom-triple', 'riscv128-unknown-elf');
    await expect(page.locator('.diagnostics')).toContainText('unknown target triple');
    // …and it recovers.
    await page.fill('#custom-triple', 'riscv64-unknown-elf');
    await expect(page.locator('.record .title')).toContainText('Example');
  });

  test('undo and redo cover the options as well as the text', async ({ page }) => {
    await waitReady(page);
    expect(await statValues(page)).toEqual(['40', '8', '13']);

    // Nothing has been done yet, so there is nothing to undo.
    await expect(page.locator('#undo')).toBeDisabled();
    await expect(page.locator('#redo')).toBeDisabled();

    // An option change is a step: this is the half an editor's own undo stack
    // knows nothing about.
    await page.selectOption('#target', 'avr-unknown-unknown');
    await expect.poll(() => statValues(page)).toEqual(['21', '1', '0']);
    await expect(page.locator('#undo')).toBeEnabled();

    await page.locator('#undo').click();
    await expect.poll(() => statValues(page)).toEqual(['40', '8', '13']);
    await page.locator('#redo').click();
    await expect.poll(() => statValues(page)).toEqual(['21', '1', '0']);

    // And the keyboard, which has to beat the editor to the keystroke.
    await page.locator('.monaco-editor').click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => statValues(page)).toEqual(['40', '8', '13']);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(() => statValues(page)).toEqual(['21', '1', '0']);
  });

  test('choosing a language puts that language in the buffer', async ({ page }) => {
    await waitReady(page);
    const editor = page.locator('.monaco-editor .view-lines');
    await expect(editor).toContainText('struct Example');

    // C source in front of a C++ compile is a question nobody asked; the
    // language's own first example is what a reader who switched wants to see.
    await page
      .locator('.segmented label', { hasText: /^C\+\+$/ })
      .locator('span')
      .click();
    await expect(editor).toContainText('virtual ~Base');
    await expect(editor).not.toContainText('struct Example');

    // And their own text is one step away, since the language and the buffer
    // changed together.
    await page.locator('#undo').click();
    await expect(editor).toContainText('struct Example');
  });

  test('undo puts back the text, one step per pause', async ({ page }) => {
    await waitReady(page);
    await page.locator('.monaco-editor').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('struct A { char a; };');
    await expect.poll(() => statValues(page), { timeout: 30_000 }).toEqual(['1', '1', '0']);

    // One step, not one per character.
    await page.locator('#undo').click();
    await expect.poll(() => statValues(page), { timeout: 30_000 }).toEqual(['40', '8', '13']);
  });

  test('the history does not survive a reload', async ({ page }) => {
    await waitReady(page);
    await page.selectOption('#target', 'avr-unknown-unknown');
    await expect(page.locator('#undo')).toBeEnabled();
    await page.reload();
    await expect(page.locator('#results')).toBeVisible({ timeout: 240_000 });
    // The URL carries the state but not how it was arrived at, and undoing
    // across a reload would put back something the visitor never did here.
    await expect(page.locator('#undo')).toBeDisabled();
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

  test('several sources live in tabs, and a link carries them all', async ({ page, context }) => {
    await waitReady(page);
    // One source shows no tab bar; the "+" is the whole affordance.
    await expect(page.locator('.tabs')).toHaveCount(0);
    await page.click('button[aria-label="New source"]');
    await expect(page.locator('.tabs .tab')).toHaveCount(2);

    // The new tab is active and empty; what is typed there is laid out.
    await page.locator('.monaco-editor').click();
    await page.keyboard.type('struct B { char c; int i; };');
    await expect.poll(() => statValues(page), { timeout: 30_000 }).toEqual(['8', '4', '3']);

    // Switching back is switching the question: the first buffer's records return.
    await page.locator('.tab-name', { hasText: 'Source 1' }).click();
    await expect.poll(() => statValues(page), { timeout: 30_000 }).toEqual(['40', '8', '13']);

    // The link carries every buffer and opens on the one that was on screen.
    await page.waitForTimeout(800); // hash sync is debounced
    const page2 = await context.newPage();
    await page2.goto(page.url());
    await expect(page2.locator('#results')).toBeVisible({ timeout: 120_000 });
    await expect(page2.locator('.tabs .tab')).toHaveCount(2);
    await expect.poll(() => statValues(page2), { timeout: 30_000 }).toEqual(['40', '8', '13']);
    await page2.locator('.tab-name', { hasText: 'Source 2' }).click();
    await expect.poll(() => statValues(page2), { timeout: 30_000 }).toEqual(['8', '4', '3']);

    // Closing the active tab lands on its neighbour, and the bar folds away.
    await page2.locator('button[aria-label="Close Source 2"]').click();
    await expect(page2.locator('.tabs')).toHaveCount(0);
    await expect.poll(() => statValues(page2), { timeout: 30_000 }).toEqual(['40', '8', '13']);
  });

  test('works offline after the first visit (PWA)', async ({ page, context }) => {
    await waitReady(page);
    await expect
      .poll(
        async () => {
          await page.hover('#info-button');
          return page.locator('#offline-status').isVisible();
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#results')).toBeVisible({ timeout: 120_000 });
    await page.selectOption('#target', 'avr-unknown-unknown');
    await expect.poll(() => statValues(page)).toEqual(['21', '1', '0']);
    // The headers are local too, not just the wasm; this is what shipping
    // them in the payload rather than fetching them on demand is for.
    await page.selectOption('#target', 'x86_64-unknown-linux-gnu');
    await page.selectOption('#example', { label: 'Using standard library (libc++)' });
    await expect.poll(() => page.locator('.record .title').textContent()).toContain('Probe');
    expect((await statValues(page))[0]).toBe('72');
    await context.setOffline(false);
  });
});
