/** Measure the boxes behind two reported visual faults, instead of guessing at the CSS. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE = process.argv[2];
const raw = fs.readFileSync('.env.local','utf8');
const env = k => (raw.match(new RegExp(`^${k}=(.*)$`,'m'))??[])[1]?.trim().replace(/^"|"$/g,'');
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})).newPage();
await p.goto(BASE+'/login',{waitUntil:'networkidle'});
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p.locator('input[type="password"]').first().evaluate((el,v)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));},env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(7000);

const start = p.locator('button:has-text("Start a customer"):visible').first();
if (await start.count()) { await start.click(); await p.waitForTimeout(1200); }
await p.locator('button:has-text("Add an item"):visible').first().click();
await p.waitForTimeout(900);
await p.locator('input[aria-label="Search products"]:visible').first().fill('american');
await p.waitForTimeout(1600);
await p.locator('[class*="pickItem"]:visible').first().click();
await p.waitForTimeout(1600);

console.log('--- quantity field boxes ---');
console.log(JSON.stringify(await p.evaluate(() => {
  const inp = document.querySelector('[class*="stepperField"] input');
  const wrap = inp.parentElement;
  const affix = [...wrap.children].find(c => c !== inp);
  const box = e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; };
  const cs = getComputedStyle(affix);
  return {
    stepperField: box(wrap.parentElement),
    wrap: box(wrap),
    input: box(inp),
    affix: { ...box(affix), text: affix.textContent, pad: cs.paddingLeft + '/' + cs.paddingRight,
             flex: cs.flex, scrollW: affix.scrollWidth, clientW: affix.clientWidth },
    wrapOverflows: wrap.scrollWidth > wrap.clientWidth,
    parentOverflow: getComputedStyle(wrap.parentElement).overflow,
  };
}, null), null, 1));

console.log('--- button icon vs label ---');
await p.getByRole('button',{name:'People',exact:true}).first().click();
await p.waitForTimeout(2500);
console.log(JSON.stringify(await p.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.offsetParent && /Add a customer/i.test(b.textContent));
  if (!btn) return 'no button';
  const svg = btn.querySelector('svg');
  const r = e => { const x = e.getBoundingClientRect(); return { top: Math.round(x.top), h: Math.round(x.height), mid: Math.round(x.top + x.height/2) }; };
  // The label may be a text node or wrapped in an element; find whichever holds it.
  const holder = [...btn.childNodes].find(n => (n.nodeType === 3 || n.nodeType === 1) && n !== svg && n.textContent.trim());
  const range = document.createRange();
  range.selectNodeContents(holder);
  const tr = range.getBoundingClientRect();
  const cs = getComputedStyle(svg);
  return {
    button: r(btn), svg: { ...r(svg), display: cs.display, verticalAlign: cs.verticalAlign },
    text: { top: Math.round(tr.top), h: Math.round(tr.height), mid: Math.round(tr.top + tr.height/2) },
    alignItems: getComputedStyle(btn).alignItems,
  };
}, null), null, 1));
await b.close();
