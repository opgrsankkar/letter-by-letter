// End-to-end: three phones play a full round in a real browser against the
// built client. Requires `vite build` first (npm run test:e2e does it) and a
// Chromium binary (CHROME_PATH, or a Playwright-managed / system Chrome).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startServer, type RunningServer } from '../../src/server/server.ts';

const root = resolve(import.meta.dirname, '../..');
const shots = join(root, 'test-results');

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), '.cache/ms-playwright');
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = join(cache, dir, sub);
        if (existsSync(p)) return p;
      }
    }
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
}

let server: RunningServer;
let browser: Browser;
let base: string;

before(async () => {
  mkdirSync(shots, { recursive: true });
  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: join(root, 'dist/client'),
    maxRooms: 10,
    maxConnections: 50,
    abandonAfterMs: 60_000,
    awayAfterMs: 60_000,
    sweepEveryMs: 60_000,
    heartbeatMs: 60_000,
    rateBurst: 40,
    ratePerSecond: 10,
    log: () => {},
  });
  base = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: findChrome() });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

interface Phone {
  name: string;
  context: BrowserContext;
  page: Page;
  problems: string[];
}

async function phone(name: string, scheme: 'light' | 'dark' = 'light'): Promise<Phone> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  return { name, context, page, problems };
}

async function snap(p: Phone, label: string) {
  await p.page.waitForTimeout(1300); // let the tile animations settle
  await p.page.screenshot({ path: join(shots, `${label}.png`), fullPage: true });
}

test('three players play a full round in the browser', { timeout: 60_000 }, async () => {
  const asha = await phone('Asha');
  const ben = await phone('Ben', 'dark');
  const chen = await phone('Chen');
  const all = [asha, ben, chen];

  try {
    // Asha opens a room.
    await asha.page.goto(base);
    await snap(asha, '01-home');
    await asha.page.getByLabel('Your name').fill('Asha');
    await asha.page.getByRole('button', { name: 'Start a new room' }).click();
    await asha.page.waitForURL(/\/r\/[A-Z0-9]{4}$/);
    const code = asha.page.url().slice(-4);
    await asha.page.getByText('Gather round').waitFor();

    // Ben and Chen follow the invite link.
    for (const p of [ben, chen]) {
      await p.page.goto(`${base}/r/${code}`);
      await assert.doesNotReject(p.page.getByLabel('Room code').waitFor());
      assert.equal(await p.page.getByLabel('Room code').inputValue(), code);
      await p.page.getByLabel('Your name').fill(p.name);
      await p.page.getByRole('button', { name: 'Join room' }).click();
      await p.page.getByText('Gather round').waitFor();
    }
    await asha.page.getByRole('button', { name: 'Start the game' }).waitFor();
    await snap(asha, '02-lobby');

    await asha.page.getByRole('button', { name: 'Start the game' }).click();

    // Exactly one phone becomes the clue-giver.
    await Promise.all(all.map((p) => p.page.locator('.phase-choosing').waitFor()));
    const hostFlags = await Promise.all(all.map((p) => p.page.getByText('Pick a secret word').isVisible()));
    assert.equal(hostFlags.filter(Boolean).length, 1);
    const host = all[hostFlags.indexOf(true)];
    const holders = all.filter((p) => p !== host);
    await snap(holders[0], '03-waiting');

    await host.page.getByPlaceholder('Secret word').fill('pancake');
    await host.page.getByRole('button', { name: 'Deal 7 letters' }).waitFor();
    await snap(host, '04-choose');
    await host.page.getByRole('button', { name: 'Deal 7 letters' }).click();
    await host.page.getByText('Who guessed it?').waitFor();
    await snap(host, '05-host-play');

    // Holders peek at their letters; together they spell the word.
    const letters: string[] = [];
    for (const h of holders) {
      const hand = h.page.locator('button.hand');
      await hand.waitFor();
      assert.equal(await hand.getAttribute('aria-pressed'), 'false');
      await hand.click();
      assert.equal(await hand.getAttribute('aria-pressed'), 'true');
      letters.push(...(await hand.locator('.tile-face').allInnerTexts()));
    }
    assert.deepEqual(letters.sort(), 'PANCAKE'.split('').sort());
    assert.ok(!(await holders[0].page.content()).includes('PANCAKE'));
    await snap(holders[0], '06-holder-hand');

    // A refresh mid-round keeps the seat and the letters.
    const mine = await holders[0].page.locator('button.hand .tile-face').allInnerTexts();
    await holders[0].page.reload();
    await holders[0].page.locator('button.hand').waitFor();
    assert.deepEqual(await holders[0].page.locator('button.hand .tile-face').allInnerTexts(), mine);

    // The clue-giver credits the guesser.
    await host.page.getByRole('button', { name: holders[1].name, exact: true }).click();
    for (const p of all) {
      await p.page.getByText('The word was').waitFor();
      await p.page.getByText(`${holders[1].name} got it`).waitFor();
    }
    await snap(host, '07-reveal');
    await snap(ben, '08-reveal-dark');

    // Room sheet opens from the top bar.
    await chen.page.getByRole('button', { name: new RegExp(`Room ${code}`) }).click();
    await chen.page.getByRole('dialog').waitFor();
    await snap(chen, '09-room-sheet');
    await chen.page.keyboard.press('Escape');

    await chen.page.getByRole('button', { name: 'Next round' }).click();
    await Promise.all(all.map((p) => p.page.getByText('Round 2').waitFor()));

    for (const p of all) assert.deepEqual(p.problems, [], `${p.name} had browser errors`);

    // No horizontal scroll at phone width.
    for (const p of all) {
      const overflow = await p.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${p.name} scrolls sideways by ${overflow}px`);
    }
  } finally {
    await Promise.all(all.map((p) => p.context.close()));
  }
});
