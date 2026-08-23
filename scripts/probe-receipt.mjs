/** Settle one tiny cash sale and report exactly where the app ends up. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE = process.argv[2];
const raw = fs.readFileSync('.env.local','utf8');
const env = k => (raw.match(new RegExp(`^${k}=(.*)$`,'m'))??[])[1]?.trim().replace(/^"|"$/g,'');
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})).newPage();
p.on('console', m => { const t=m.text(); if(t.startsWith('[')) console.log('  ',t); });
p.on('pageerror', e => console.log('   PAGEERROR', e.message));

await p.goto(BASE+'/login',{waitUntil:'networkidle'});
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p.locator('input[type="password"]').first().evaluate((el,v)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));},env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(7000);

const start = p.locator('button:has-text("Start a customer"):visible').first();
if (await start.count()) { await start.click(); await p.waitForTimeout(1200); }

await p.locator('button:has-text("Add an item"):visible').first().click();
await p.waitForTimeout(900);
await p.locator('input[aria-label="Search products"]:visible').first().fill('coca');
await p.waitForTimeout(1600);
await p.locator('[class*="pickItem"]:visible').first().click();
await p.waitForTimeout(1500);

await p.locator('button:has-text("Take payment"):visible').first().click();
await p.waitForTimeout(1600);
const dlg = p.locator('[role="dialog"]').first();
await dlg.locator('button:has-text("Pay all")').first().click();
await p.waitForTimeout(1200);
console.log('   settling…');
await dlg.getByRole('button', { name: /Mark as paid|rest on account/i }).click();

for (const t of [1000,2000,3000,5000]) {
  await p.waitForTimeout(t===1000?1000:1000);
  const nav = new URL(p.url()).searchParams.get('nav') || '';
  const heads = await p.evaluate(()=>[...document.querySelectorAll('h1,h2')].filter(e=>e.offsetParent!==null).map(e=>e.textContent.trim()).slice(0,4));
  console.log(`   +${t}ms nav=${decodeURIComponent(nav).slice(0,90)} | visible headings: ${JSON.stringify(heads)}`);
}
await p.screenshot({path:'shots/probe-receipt.png'});
await b.close();
