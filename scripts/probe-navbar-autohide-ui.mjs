/**
 * THE TAB BAR SLIDES AWAY ON A SCROLL DOWN AND COMES BACK ON A SCROLL UP — on every tab.
 *
 * navigation-stack 1.10.1 broadcast each Scaffold scroll twice under two names (route key and uid);
 * the bar takes a new name for a new page and showed itself on every scroll, so it never hid
 * (iPhone, 10 Nov). Scrolled in wheel steps, as a finger does: one jump can land as a page's first
 * event, which the bar rightly answers by showing itself.
 *
 *     node scripts/probe-navbar-autohide-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE = process.argv[2] ?? 'http://localhost:3100';
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
const barTop = () => p.evaluate(() => {
  const w = document.querySelector('[class*="page_navWrap"]');
  const el = w && [...w.querySelectorAll('*')].find((e) => e.getBoundingClientRect().height > 40);
  return el ? Math.round(el.getBoundingClientRect().top) : null;
});
for (const tab of ['Stock', 'Money', 'Sell']) {
  await p.getByRole('button', { name: tab, exact: true }).first().click();
  await p.waitForTimeout(2000);
  const before = await barTop();
  await p.mouse.move(195, 400);
  for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, 120); await p.waitForTimeout(120); }
  await p.waitForTimeout(700);
  const down = await barTop();
  for (let i = 0; i < 2; i++) { await p.mouse.wheel(0, -120); await p.waitForTimeout(120); }
  await p.waitForTimeout(700);
  const up = await barTop();
  if (!(down > before && up === before)) process.exitCode = 1;
  console.log(`${tab}: bar top ${before} -> scrolled down ${down} -> scrolled up ${up}  ${down > before && up === before ? 'PASS' : 'FAIL'}`);
}
await b.close();
