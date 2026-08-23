/** Photograph the two reported faults so they can be judged, not just measured. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE = process.argv[2];
const raw = fs.readFileSync('.env.local','utf8');
const env = k => (raw.match(new RegExp(`^${k}=(.*)$`,'m'))??[])[1]?.trim().replace(/^"|"$/g,'');
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3})).newPage();
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
await p.locator('[class*="sell-page_line__"]:visible').first().screenshot({ path:'shots/fix-line.png' });
console.log('captured shots/fix-line.png');

// Buttons with icons, on the customer account screen the user showed.
await p.getByRole('button',{name:'People',exact:true}).first().click();
await p.waitForTimeout(2500);
const row = p.getByRole('button', { name: /Irekanmi/ }).first();
if (await row.count()) {
  await row.click();
  await p.getByText(/Everything that has happened/i).first().waitFor({ timeout: 20000 }).catch(()=>{});
  await p.waitForTimeout(1500);
  const actions = p.locator('[class*="account-page_actions"]:visible').first();
  if (await actions.count()) { await actions.screenshot({ path:'shots/fix-buttons.png' }); console.log('captured shots/fix-buttons.png'); }
}
await b.close();
