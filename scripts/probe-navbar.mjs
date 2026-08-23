/** Does the tab bar actually react to scrolling? Measure its box before and after a scroll. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE = process.argv[2];
const raw = fs.readFileSync('.env.local','utf8');
const env = k => (raw.match(new RegExp(`^${k}=(.*)$`,'m'))??[])[1]?.trim().replace(/^"|"$/g,'');
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})).newPage();
p.on('console', m => { const t=m.text(); if (t.startsWith('[navscroll]')) console.log('   ', t); });
await p.goto(BASE+'/login',{waitUntil:'networkidle'});
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p.locator('input[type="password"]').first().evaluate((el,v)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));},env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(7000);
await p.getByRole('button',{name:'Stock',exact:true}).first().click();
await p.waitForTimeout(2500);

const bar = () => p.evaluate(() => {
  // The bar the user sees: whichever element actually has height at the bottom of the screen.
  const cands = [...document.querySelectorAll('nav, [class*="nav"]')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.height > 30 && r.bottom > window.innerHeight - 200; });
  const el = cands[cands.length - 1];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { top: Math.round(r.top), h: Math.round(r.height), radius: cs.borderRadius, transform: cs.transform };
});
console.log('before scroll:', JSON.stringify(await bar()));

// Scroll the page the way a finger would.
const scrolled = await p.evaluate(() => {
  // The VISIBLE tab's scroll container. Every tab stack stays mounted, so an unscoped query
  // returns a hidden tab's body — which has no height and cannot be scrolled.
  const c = [...document.querySelectorAll('[class*="PageScaffold_body"]')]
    .find((e) => e.offsetParent !== null && e.scrollHeight > e.clientHeight);
  if (!c) return 'no scrollable container';
  if (!c) return 'no container';
  c.scrollTop = 400;
  return { scrollTop: c.scrollTop, scrollHeight: c.scrollHeight, cls: c.className };
});
console.log('scrolled:', JSON.stringify(scrolled));
await p.waitForTimeout(1500);
console.log('after scroll :', JSON.stringify(await bar()));

// The whole nav subtree, so the element that actually carries the float styling is identifiable.
const dump = () => p.evaluate(() => {
  const wrap = document.querySelector('[class*="page_navWrap"], [class*="navWrap"]');
  if (!wrap) return 'no navWrap';
  const walk = (el, d = 0) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const row = { d, tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 40),
                  top: Math.round(r.top), h: Math.round(r.height),
                  radius: cs.borderRadius, transform: cs.transform, pos: cs.position };
    return [row, ...[...el.children].flatMap((c) => (d < 2 ? walk(c, d + 1) : []))];
  };
  return walk(wrap);
});
console.log('nav tree BEFORE:', JSON.stringify(await dump(), null, 1));
await p.evaluate(() => {
  const c = [...document.querySelectorAll('[class*="PageScaffold_body"]')].find((e) => e.offsetParent !== null && e.scrollHeight > e.clientHeight);
  if (c) c.scrollTop = 800;
});
await p.waitForTimeout(1200);
console.log('nav tree AFTER :', JSON.stringify(await dump(), null, 1));
await p.screenshot({path:'shots/navbar-scrolled.png'});
await b.close();
