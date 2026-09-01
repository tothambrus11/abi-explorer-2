import { test, expect, type Browser, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';

// The Hylo backend, and the promise that makes two backends bearable: choosing
// a language downloads that language's compiler and not the other one.
//
// The two modules are 11 MB and 19 MB. Loading both to answer a question about
// one is the failure these tests exist to catch, so much of what they assert is
// about requests that must *not* happen.

// The Hylo module is optional: a build without one offers the language as
// unsupported, and there is nothing here to check.
const available = existsSync(path.join(process.cwd(), 'dist', 'vendor', 'hylo', 'manifest.json'));

/** What each module's cache holds, by file name. */
const cached = (page: Page, name: string): Promise<string[]> =>
  page.evaluate(async (cacheName) => {
    if (!(await caches.has(cacheName))) return [];
    const cache = await caches.open(cacheName);
    return (await cache.keys()).map((r) => new URL(r.url).pathname.split('/').pop()!);
  }, name);

const statValues = (page: Page) => page.locator('.summary .value').allTextContents();

/**
 * Picks a language.
 *
 * The radio itself is `opacity: 0; pointer-events: none`, so the thing a user
 * presses is the span beside it, and so is the thing this presses.
 */
async function selectLanguage(page: Page, label: string): Promise<void> {
  await page
    .locator('.segmented label', { hasText: new RegExp(`^${label}$`) })
    .locator('span')
    .click();
}

async function ready(page: Page): Promise<void> {
  await expect(page.locator('#results')).toBeVisible({ timeout: 240_000 });
  await expect(page.locator('.monaco-editor .view-lines')).toBeVisible();
}

async function type(page: Page, source: string): Promise<void> {
  await page.locator('.monaco-editor').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(source);
}

const PAIR = 'public struct Pair {\n  let x: Builtin.i8\n  let y: Builtin.i64\n';

/**
 * A link to a session already in Hylo, built by the app's own encoder.
 *
 * A page that opens in C downloads clang before Hylo can be selected, so it
 * cannot answer whether choosing Hylo avoids that. Loading straight into Hylo
 * can, and the share link is how a visitor would arrive there.
 */
async function hyloUrl(browser: Browser): Promise<string> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await ready(page);
  await selectLanguage(page, 'Hylo');
  // The source travels in the link too, so it has to be one Hylo compiles:
  // a C example under a Hylo compiler is a shared link to an error.
  await type(page, PAIR);
  await expect.poll(() => statValues(page), { timeout: 240_000 }).toEqual(['9', '8', '0']);
  // The fragment is written on a debounce, after the state it encodes.
  await expect.poll(() => page.url(), { timeout: 30_000 }).toMatch(/#.+/);
  await page.waitForTimeout(1000);
  const url = page.url();
  await context.close();
  return url;
}

test.describe('Hylo', () => {
  test.skip(!available, 'this build has no Hylo module');

  test('answers a Hylo layout without ever fetching clang', async ({ browser }) => {
    const url = await hyloUrl(browser);

    // A fresh context, so neither module is cached and every fetch is visible.
    const context = await browser.newContext();
    const page = await context.newPage();
    const wanted: string[] = [];
    await page.route('**/vendor/**', (route) => {
      wanted.push(new URL(route.request().url()).pathname);
      return route.continue();
    });

    await page.goto(url);
    // 9 bytes, aligned to 8, with no padding: Hylo puts the i64 first, so the
    // i8 that was declared first ends up last and nothing is padded between.
    await expect.poll(() => statValues(page), { timeout: 240_000 }).toEqual(['9', '8', '0']);

    expect(wanted.filter((p) => p.includes('/vendor/hylo/')).length).toBeGreaterThan(0);
    // The manifest may be read by the download gate; the module must not be.
    expect(wanted.filter((p) => /\/vendor\/abi\/.*\.(wasm|data)(\.gz)?$/.test(p))).toEqual([]);
    await context.close();
  });

  test('keeps each module in its own cache', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await expect
      .poll(() => cached(page, 'abix-abi-module-v1'), { timeout: 240_000 })
      .not.toEqual([]);
    // C is selected, so nothing of Hylo's has been downloaded.
    expect(await cached(page, 'abix-hylo-module-v1')).toEqual([]);

    await selectLanguage(page, 'Hylo');
    await expect
      .poll(() => cached(page, 'abix-hylo-module-v1'), { timeout: 240_000 })
      .not.toEqual([]);
    // And clang's copy survived: going back must not re-download it.
    expect((await cached(page, 'abix-abi-module-v1')).length).toBeGreaterThan(0);
  });

  test('shows the controls that mean something in the selected language', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await expect(page.locator('#target')).toBeVisible();

    await selectLanguage(page, 'Hylo');
    // Hylo describes one ABI and takes none of clang's flags.
    await expect(page.locator('#target')).toBeHidden();
    await expect(page.locator('details.more')).toBeHidden();

    await selectLanguage(page, 'C');
    await expect(page.locator('#target')).toBeVisible();
  });

  test('the details popover stays on the screen wherever the row ends', async ({ page }) => {
    await page.goto('/');
    await ready(page);

    // The icon sits at the end of a row whose contents depend on the language,
    // so it moves. In Hylo the target selector and the options are gone, which
    // puts the icon far to the left, where a panel anchored to its right edge
    // used to hang off the screen.
    await selectLanguage(page, 'Hylo');
    await page.hover('#info-button');
    const panel = page.locator('#info-panel');
    await expect(panel).toBeVisible();

    const seen = async () => {
      const box = (await panel.boundingBox())!;
      const width = page.viewportSize()!.width;
      return { left: box.x >= 0, right: box.x + box.width <= width };
    };
    expect(await seen()).toEqual({ left: true, right: true });

    // And in C, where the row is at its longest and the icon furthest right.
    await selectLanguage(page, 'C');
    await page.hover('#info-button');
    await expect(panel).toBeVisible();
    expect(await seen()).toEqual({ left: true, right: true });
  });

  test('lays an enum out as a union, and reports an error against its line', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await selectLanguage(page, 'Hylo');
    await type(page, 'public enum Choice {\n  case some(wrapped: Builtin.i16)\n  case none\n');

    // Two cases stored one over another, and a discriminator after them.
    await expect.poll(() => statValues(page), { timeout: 240_000 }).toEqual(['3', '2', '0']);

    await type(page, 'public struct Broken {\n  let x: Nonexistent\n');
    await expect(page.locator('.diagnostics')).toContainText('Nonexistent', { timeout: 60_000 });
  });
});
