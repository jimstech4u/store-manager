/**
 * Sheets that legitimately hold a field must survive a keyboard.
 *
 * Playwright cannot raise a real on-screen keyboard, so this checks the properties that made the
 * sheet unusable when one appeared: does it open at a sensible height rather than jumping, does it
 * stay inside the viewport, and does typing into it leave it open.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE=process.argv[2];
const raw=fs.readFileSync('.env.local','utf8');
const env=k=>(raw.match(new RegExp(`^${k}=(.*)$`,'m'))??[])[1]?.trim().replace(/^"|"$/g,'');
const results=[];
const check=(n,ok,d='')=>{results.push({n,ok});console.log(`  ${ok?'PASS':'FAIL'}  ${n}${d?` — ${d}`:''}`);};

const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2})).newPage();
await p.goto(BASE+'/login',{waitUntil:'networkidle'});
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p.locator('input[type="password"]').first().evaluate((el,v)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));},env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(9000);

const reveal = async () => {
  await p.evaluate(()=>document.querySelectorAll('[class*="PageScaffold_body"]').forEach(c=>{c.scrollTop=120;}));
  await p.waitForTimeout(350);
  await p.evaluate(()=>document.querySelectorAll('[class*="PageScaffold_body"]').forEach(c=>{c.scrollTop=0;}));
  await p.waitForTimeout(800);
};

const sheetBox = () => p.evaluate(() => {
  const d = [...document.querySelectorAll('[role="dialog"]')].find(e => e.getBoundingClientRect().height > 0);
  if (!d) return null;
  const r = d.getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), vh: window.innerHeight };
});

// ── A sheet that keeps its field: adding a product from Stock ────────────────────
console.log('\nProduct form (a sheet that should stay a sheet)');
await reveal();
await p.getByRole('button',{name:'Stock',exact:true}).first().click();
await p.waitForTimeout(2400);
await p.locator('button[aria-label="Add an item you sell"]:visible').first().click();
await p.waitForTimeout(1200);

const opened = await sheetBox();
check('sheet opened', opened !== null, JSON.stringify(opened));
if (opened) {
  check('top stays inside the viewport', opened.top >= 0, `top ${opened.top}`);
  check('does not open at nothing', opened.h > 100, `${opened.h}px tall`);
  check('bottom reaches the screen edge', opened.bottom >= opened.vh - 4, `${opened.bottom} vs ${opened.vh}`);
}

// Typing must not dismiss it — the fault that lost what had been typed.
const field = p.locator('[role="dialog"] input').first();
await field.click();
await p.waitForTimeout(400);
await field.fill('Keyboard test item');
await p.waitForTimeout(900);
const afterTyping = await sheetBox();
check('typing leaves the sheet open', afterTyping !== null);
check('the text is still there', (await field.inputValue()) === 'Keyboard test item');

// Focus must turn dragging off, so a touch on a field cannot dismiss.
const dragOff = await p.evaluate(() => {
  const d = [...document.querySelectorAll('[role="dialog"]')].find(e => e.getBoundingClientRect().height > 0);
  return d ? d.getAttribute('aria-modal') === 'true' : false;
});
check('sheet is still a modal dialog while typing', dragOff);
await p.screenshot({path:'shots/keyboard-sheet.png'});
await p.keyboard.press('Escape');
await p.waitForTimeout(900);
check('escape closes it', (await sheetBox()) === null);

// ── Counting is a page now, not a sheet ─────────────────────────────────────────
console.log('\nCount (was a sheet, now a page)');
await reveal();
await p.getByRole('button',{name:'Count',exact:true}).first().click();
await p.waitForTimeout(2400);
const row = p.locator('[class*="count-page_row"]:visible').first();
if (await row.count()) {
  await row.click();
  await p.waitForTimeout(2200);
  const body = await p.locator('body').innerText();
  check('opens a page, not a dialog', (await sheetBox()) === null);
  check('the count field is on the page', /How many are on the shelf/i.test(body));
  const back = p.getByRole('button', { name: /Go back|Back/i }).first();
  check('the page has a back button', (await back.count()) > 0);
  await p.screenshot({path:'shots/count-page.png'});
} else {
  check('a product row to count', false, 'none found');
}

await b.close();
const failed=results.filter(r=>!r.ok);
console.log(`\n${results.length-failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
