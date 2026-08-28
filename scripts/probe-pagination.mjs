/**
 * A list that has been paged through must come back the same length.
 *
 * `useLiveRefresh` reloads a screen when it is returned to, which is right — the figures on it may
 * have moved. But every list screen was calling `reload`, and `reload` starts again from page one.
 * On a list somebody had scrolled through, tapping the hundredth row and coming back gave them
 * twenty: the row they tapped gone, and the scroll that led to it with it.
 *
 * `refresh` re-reads the span that is already on screen instead, in one request, keeping its
 * length. This opens a row from the deep end of a list, comes back, and checks the list is still
 * as long as it was.
 *
 * WHAT THIS CANNOT DO: drive pagination itself. Neither assigning `scrollTop` nor a wheel event
 * makes the sentinel's IntersectionObserver fire in headless Chromium, while a real phone
 * paginates perfectly — so an earlier version of this probe reported the app broken when it was
 * the harness that could not scroll. It therefore uses whatever length the list already has.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const raw = fs.readFileSync('.env.local', 'utf8');
const env = (k) => (raw.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1]?.trim().replace(/^"|"$/g, '');

const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
};

const b = await chromium.launch();
const p = await (
  await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
).newPage();

await p.goto(BASE + '/login', { waitUntil: 'networkidle' });
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p
  .locator('input[type="password"]')
  .first()
  .evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(9000);

await p.evaluate(() => {
  document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { c.scrollTop = 120; });
});
await p.waitForTimeout(350);
await p.evaluate(() => {
  document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { c.scrollTop = 0; });
});
await p.waitForTimeout(800);

/*
 * The MONEY list, which carries a persisted multi-page list from earlier visits.
 *
 * Driving pagination from the harness turned out to be impossible: neither assigning `scrollTop`
 * nor a wheel event makes the IntersectionObserver fire in headless Chromium, while a real phone
 * paginates perfectly. So this no longer tries to CREATE a long list — it uses one that is already
 * long and tests the thing that was actually reported: that returning to it does not shorten it.
 */
await p.getByRole('button', { name: 'Money', exact: true }).first().click();
await p.waitForTimeout(2800);

// The active stack's scroller — other tabs stay mounted but have no height.
const rows = () => p.locator('[class*="people-page_row"]:visible, [class*="rowLink"]:visible').count();
const scrollTop = () =>
  p.evaluate(() => {
    const c = [...document.querySelectorAll('[class*="PageScaffold_body"]')].find(
      (el) => el.scrollHeight > el.clientHeight && el.getBoundingClientRect().height > 0,
    );
    return c ? Math.round(c.scrollTop) : 0;
  });

const first = await rows();
console.log(`  ${first} rows at rest`);

/*
 * Get to the bottom so the row tapped below is a late one. This does not paginate — see the note
 * at the top — it just moves to the end of what is loaded.
 */
await p.evaluate(() => {
  const c = [...document.querySelectorAll('[class*="PageScaffold_body"]')].find(
    (el) => el.scrollHeight > el.clientHeight && el.getBoundingClientRect().height > 0,
  );
  if (c) c.scrollTop = c.scrollHeight;
});
await p.waitForTimeout(1500);

const paged = await rows();
const scrolledTo = await scrollTop();
console.log(`  ${paged} rows loaded, scrolled to ${scrolledTo}px`);
if (paged <= 30) {
  console.log('  NOTE: only one page loaded here — the length test below is weaker than intended.');
}

// Open a row from the DEEP end — the case that was losing everything.
const deep = p.locator('[class*="rowLink"]:visible').nth(Math.max(0, paged - 3));
const deepName = (await deep.innerText()).split('\n')[0];
console.log(`  opening a late row: ${deepName}`);
await deep.click();
await p.waitForTimeout(3000);
check('it pushed a page', /What makes up this balance|owe|Account/i.test(await p.locator('body').innerText()));

await p.goBack();
await p.waitForTimeout(3200);

const back = await rows();
const backScroll = await scrollTop();
console.log(`  back: ${back} rows, scrolled to ${backScroll}px`);

/*
 * Scroll restoration is navigation-stack's job and is measured separately; what matters here is
 * that the list did not get SHORTER, which is what `reload` on resume was doing to it.
 */
check('it did not shorten', back >= paged, `${back} vs ${paged}`);
await p.screenshot({ path: 'shots/pagination-back.png' });

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
