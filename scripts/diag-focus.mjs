/**
 * What has focus in the same task as the tap that opens a search — the only focus iOS keyboards
 * answer. Diagnostic only.
 *
 *     node scripts/diag-focus.mjs
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:3100';
const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
p.on('console', (m) => { if (m.text().startsWith('[focus]')) console.log(m.text()); });
await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(14000);
await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
await p.waitForTimeout(6000);

await p.evaluate(() => {
  const describe = () => {
    const a = document.activeElement;
    return `${a?.tagName}${a?.getAttribute('aria-hidden') ? '(stand-in)' : ''}${a?.closest?.('[role="dialog"]') ? '(in dialog)' : ''}`;
  };
  const obs = new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (n.tagName === 'INPUT' && n.getAttribute('aria-hidden')) console.log('[focus] stand-in input added');
    }
  });
  obs.observe(document.body, { childList: true });
  document.addEventListener('click', () => {
    console.log('[focus] during the click handler chain:', describe());
    queueMicrotask(() => console.log('[focus] microtask after the click:', describe()));
    setTimeout(() => console.log('[focus] next task:', describe()), 0);
    setTimeout(() => console.log('[focus] 100ms:', describe()), 100);
    setTimeout(() => console.log('[focus] 600ms:', describe()), 600);
  }, true);
});
await p.getByRole('button', { name: /Search your stock/i }).first().click();
await p.waitForTimeout(1500);

// The flash: a term with nothing, then its correction, watched on every frame.
const box = p.locator('[role="dialog"] input').first();
await box.fill('zzqqxx');
await p.waitForTimeout(3500);
await p.evaluate(() => {
  const start = performance.now();
  let last = '';
  const look = () => {
    const txt = document.body.innerText;
    const now = /Try part of the name/.test(txt) ? 'EMPTY' : /Goldberg Bottle/.test(txt) ? 'MATCH' : /Searching/.test(txt) ? 'LOADING' : 'other';
    const val = document.querySelector('[role="dialog"] input')?.value;
    if (now !== last) { console.log(`[focus] ${Math.round(performance.now() - start)}ms ${now} (box: ${val})`); last = now; }
    if (now !== 'MATCH' && performance.now() - start < 8000) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
});
await box.fill('Goldberg');
await p.waitForTimeout(6000);
await browser.close();
process.exit(0);
