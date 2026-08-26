/**
 * Two reported faults on one long page:
 *   1. the FAB never appears while scrolling
 *   2. the floating total jumps back above the bar when you reach the bottom
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE=process.argv[2];
const raw=fs.readFileSync('.env.local','utf8');
const env=k=>(raw.match(new RegExp(`^${k}=(.*)$`,'m'))??[])[1]?.trim().replace(/^"|"$/g,'');
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2})).newPage();
await p.goto(BASE+'/login',{waitUntil:'networkidle'});
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p.locator('input[type="password"]').first().evaluate((el,v)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));},env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(9000);

// Build an order long enough that the SELL page itself scrolls — that is the only page carrying
// the floating total, and a short page can neither hide the bar nor show the FAB.
const start = p.locator('button:has-text("Start a customer"):visible').first();
if (await start.count()) { await start.click(); await p.waitForTimeout(1200); }
for (const term of ['coca','eva','gold','star']) {
  await p.locator('button:has-text("Add an item"):visible').first().click();
  await p.waitForTimeout(900);
  // The sell picker is a SelectionViewer; its search box is the last visible input once open.
  await p.locator('input:visible').last().fill(term);
  await p.waitForTimeout(1600);
  const row = p.locator('[class*="pickItem"]:visible').first();
  if (await row.count()) { await row.click(); await p.waitForTimeout(1200); }
}

const read = async (label) => {
  const m = await p.evaluate(() => {
    const nav = document.querySelector('nav.navigation-bar');
    const fab = document.querySelector('.fab');
    const pill = [...document.querySelectorAll('button')]
      .find(b => /Take payment|Fix the quantity/.test(b.textContent) && b.getBoundingClientRect().height > 0);
    const c = [...document.querySelectorAll('[class*="PageScaffold_body"]')]
      .find(e => e.getBoundingClientRect().height > 0 && e.scrollHeight > e.clientHeight);
    const r = e => Math.round(e.getBoundingClientRect().top);
    return {
      scrollTop: c ? Math.round(c.scrollTop) : null,
      max: c ? Math.round(c.scrollHeight - c.clientHeight) : null,
      navTop: nav ? r(nav) : null,
      navHidden: nav ? !/matrix\(1, 0, 0, 1, 0, 0\)/.test(getComputedStyle(nav).transform) : null,
      fab: fab ? r(fab) : null,
      pillTop: pill ? r(pill) : null,
    };
  });
  console.log(`  ${label.padEnd(22)} ${JSON.stringify(m)}`);
  return m;
};

const scrollTo = async (y) => {
  await p.evaluate((top) => {
    const c = [...document.querySelectorAll('[class*="PageScaffold_body"]')]
      .find(e => e.getBoundingClientRect().height > 0 && e.scrollHeight > e.clientHeight);
    if (c) c.scrollTop = top === 'end' ? c.scrollHeight : top;
  }, y);
  await p.waitForTimeout(1000);
};

/*
 * Scroll the way a finger does: many small events rather than one jump.
 *
 * The jump version passed while the reported fault is real, and this is why — a wheel produces a
 * stream of positions including several AT the bottom edge, where the container clamps and the
 * position stops changing or ticks backwards. That is the case the handler has to get right.
 */
const wheel = async (steps, dy) => {
  await p.mouse.move(195, 400);
  for (let i = 0; i < steps; i += 1) {
    await p.mouse.wheel(0, dy);
    await p.waitForTimeout(90);
  }
  await p.waitForTimeout(700);
};

await scrollTo(0);
await read('at top');
await wheel(4, 120);   await read('wheeled down a little');
await wheel(10, 200);  const mid = await read('wheeled down more');
await p.screenshot({path:'shots/scroll-mid.png'});
// Well past the end, so the last events land on the clamped bottom.
await wheel(25, 400);  const bottom = await read('wheeled to the bottom');
await p.screenshot({path:'shots/scroll-bottom.png'});

console.log('\n  FAB appears while the bar is hidden:', mid.navHidden ? (mid.fab !== null) : 'bar never hid');
console.log('  pill stays down at the bottom:', bottom.pillTop !== null && mid.pillTop !== null
  ? bottom.pillTop >= mid.pillTop : 'no pill');
await b.close();
