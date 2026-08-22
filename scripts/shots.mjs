/**
 * Screenshot the live site so it can be LOOKED at, not just asserted about.
 *
 * Tests prove behaviour; they say nothing about whether a screen is readable, whether a number is
 * cramped, or whether a button falls below the fold on a phone. This product is for people
 * working one-handed at a counter, several of them over 50, so how it actually looks is a
 * requirement rather than a finishing touch.
 *
 * Shot at 390×844 — an ordinary phone — because that is the device this runs on. Desktop is the
 * exception here, not the default.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const OUT = path.join(process.cwd(), 'shots');
fs.mkdirSync(OUT, { recursive: true });

function creds() {
  const raw = fs.readFileSync('.env.local', 'utf8');
  const get = (k) => (raw.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1]?.trim().replace(/^"|"$/g, '');
  return { email: get('SAMPLE_EMAIL'), password: get('SAMPLE_PASSWORD'), code: '7R8U2A' };
}

/** Never let the password reach Playwright's trace or a screenshot of a focused field. */
async function typeSecret(page, selector, value) {
  await page.locator(selector).first().evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

const shots = [];

async function shoot(page, name, note) {
  // Scroll to the bottom and back before capturing. Images are lazy-loaded, and a fullPage
  // screenshot does not trigger that — so anything below the fold photographs as an empty box
  // and reads as a broken image when it is simply one that was never asked for.
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 250));
  });

  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  shots.push({ name, note });
  console.log(`  captured ${name}`);
}

const run = async () => {
  const { email, password, code } = creds();
  const browser = await chromium.launch();

  // ── Public pages, as a shopper on a phone ───────────────────────────────────────
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await phone.newPage();

  console.log('public:');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shoot(page, '01-marketplace', 'landing page, phone');

  await page.goto(`${BASE}/s/${code}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shoot(page, '02-storefront', 'one shop, by code');

  // Open an item so the bulk ladder is visible.
  const firstCard = page.locator('button').filter({ hasText: 'Coca-Cola' }).first();
  if (await firstCard.count()) {
    await firstCard.click();
    await page.waitForTimeout(900);
    await shoot(page, '03-product', 'product sheet with bulk prices');
    await page.keyboard.press('Escape');
  }

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shoot(page, '04-login', 'sign in');

  // ── Signed in, as the shop ──────────────────────────────────────────────────────
  console.log('signed in:');
  await page.locator('input[type="email"]').first().fill(email);
  await typeSecret(page, 'input[type="password"]', password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(6000);
  await shoot(page, '05-app', 'after sign in');

  for (const [tab, name] of [
    ['Sell', '06-sell'],
    ['Stock', '07-stock'],
    ['Count', '08-count'],
    ['Money', '09-money'],
    ['More', '10-settings'],
  ]) {
    const btn = page.getByRole('button', { name: tab }).first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(2500);
      await shoot(page, name, `${tab} tab`);
    }
  }

  // ── Desktop, to check the layout does not fall apart ────────────────────────────
  const wide = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const desk = await wide.newPage();
  console.log('desktop:');
  await desk.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await desk.waitForTimeout(1500);
  await shoot(desk, '11-marketplace-desktop', 'landing page, desktop');

  await browser.close();

  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(shots, null, 2));
  console.log(`\n${shots.length} screenshots in ${OUT}`);
};

run().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
