// End-to-end: three phones play a full round in a real browser against the
// built client. Requires `vite build` first (npm run test:e2e does it) and a
// Chromium binary (CHROME_PATH, or a Playwright-managed / system Chrome).
// Set E2E_BASE_URL to run it against a deployed server instead.

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

let server: RunningServer | undefined;
let browser: Browser;
let base: string;

before(async () => {
  mkdirSync(shots, { recursive: true });
  browser = await chromium.launch({ executablePath: findChrome() });
  // E2E_BASE_URL points the test at an already-running deployment instead.
  if (process.env.E2E_BASE_URL) {
    base = process.env.E2E_BASE_URL.replace(/\/$/, '');
    return;
  }
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
    maxConnectionsPerIp: 50,
    maxRoomsPerIpPer10Min: 10,
    trustProxy: false,
    log: () => {},
  });
  base = `http://127.0.0.1:${server.port}`;
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
    await host.page.getByText('Heard the word?').waitFor();
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
    // Face down again after the refresh, and nothing readable until peeked.
    assert.deepEqual((await holders[0].page.locator('button.hand .tile-face').allInnerTexts()).join(''), '');
    await holders[0].page.locator('button.hand').click();
    assert.deepEqual(await holders[0].page.locator('button.hand .tile-face').allInnerTexts(), mine);

    // Stage 1 -> 2: holders hint, then the clue-giver opens the word clue.
    // Holders hint in the dealt order: exactly one of them has the turn at a time.
    await host.page.getByText('Stay quiet for now').waitFor();
    for (let turn = 0; turn < holders.length; turn += 1) {
      await holders[0].page.waitForTimeout(300);
      const up = [];
      for (const h of holders) if (await h.page.getByText('Your turn to hint').isVisible()) up.push(h);
      assert.equal(up.length, 1, `exactly one holder is up on turn ${turn}`);
      await up[0].page.getByRole('button', { name: 'I’ve hinted my letters' }).click();
      await up[0].page.getByText('✓ Hinted').waitFor();
    }
    await host.page.getByRole('heading', { name: 'Everyone has hinted' }).waitFor();
    await host.page.getByRole('button', { name: 'Start my word clue' }).click();
    await host.page.getByRole('heading', { name: 'Clue the whole word' }).waitFor();
    await holders[0].page.getByText('Word clue', { exact: true }).waitFor();

    // The clue-giver credits a guesser, then fixes the mis-tap from the reveal.
    await host.page.getByRole('button', { name: `${holders[1].name} guessed it, plus 1` }).click();
    for (const p of all) {
      await p.page.getByText('The word was').waitFor();
      await p.page.getByText(`${holders[1].name} got it`).waitFor();
    }
    await host.page.getByRole('button', { name: /Fix it/ }).click();
    await host.page.getByRole('radio', { name: /after their own hint/ }).click();
    await host.page.getByRole('button', { name: `${holders[0].name} guessed it` }).click();
    for (const p of all) await p.page.getByText(`${holders[0].name} got it from the letters alone`).waitFor();
    await snap(host, '07-reveal');
    await snap(ben, '08-reveal-dark');

    // Room sheet opens from the top bar.
    await chen.page.getByRole('button', { name: new RegExp(`Room ${code}`) }).click();
    await chen.page.getByRole('dialog').waitFor();
    await snap(chen, '09-room-sheet');
    await chen.page.keyboard.press('Escape');

    // Only the outgoing clue-giver (or the owner, Asha) gets the Next round button.
    for (const p of all) {
      const visible = await p.page.getByRole('button', { name: 'Next round' }).isVisible();
      assert.equal(visible, p === host || p === asha, `${p.name} next-round button`);
    }
    const waiting = all.find((p) => p !== host && p !== asha);
    if (waiting) await waiting.page.getByText(`Waiting for ${host.name} to start the next round`).waitFor();
    await host.page.getByRole('button', { name: 'Next round' }).click();
    await Promise.all(all.map((p) => p.page.getByText('Round 2').waitFor()));
    await all.find((p) => p.page.url() && p !== host)!.page.getByText('Last round').waitFor();

    // Until the next word is dealt, the last clue-giver can still fix the credit.
    await host.page.getByRole('button', { name: 'Fix scoring', exact: true }).click();
    await host.page.getByRole('radio', { name: /After the word clue/ }).click();
    await host.page.getByRole('button', { name: `${holders[1].name} guessed it` }).click();
    for (const p of all) await p.page.locator('.recap', { hasText: `${holders[1].name} +1` }).waitFor();

    // An invite link to a different room wins over the saved seat.
    await chen.page.goto(`${base}/r/WXYA`);
    await chen.page.getByRole('button', { name: 'Join room' }).waitFor();
    assert.equal(await chen.page.getByLabel('Room code').inputValue(), 'WXYA');
    assert.ok(chen.page.url().endsWith('/r/WXYA'));
    // ...and going back to the old room's link resumes the seat.
    await chen.page.goto(`${base}/r/${code}`);
    await chen.page.getByText('Round 2').waitFor();

    // The owner ends the game: everyone sees final scores; only the owner can restart.
    await asha.page.getByRole('button', { name: new RegExp(`Room ${code}`) }).click();
    await asha.page.getByRole('button', { name: /End game/ }).click();
    await asha.page.getByRole('button', { name: /Tap again to end/ }).click();
    for (const p of all) await p.page.getByText('Final scores').waitFor();
    await snap(asha, '10-final');
    await asha.page.getByRole('button', { name: 'Start a new game' }).waitFor();
    assert.equal(await ben.page.getByRole('button', { name: 'Start a new game' }).count(), 0);

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
