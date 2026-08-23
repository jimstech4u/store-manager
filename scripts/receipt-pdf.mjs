/**
 * Drive the real receipt screen and save the PDF it produces, so it can be LOOKED at.
 *
 * A PDF writer with no library is exactly the kind of code that produces a file some readers open
 * and others reject. The only honest check is to generate one from the live screen and open it.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE = process.argv[2];
const raw = fs.readFileSync('.env.local','utf8');
const env = k => (raw.match(new RegExp(`^${k}=(.*)$`,'m'))??[])[1]?.trim().replace(/^"|"$/g,'');

const b = await chromium.launch();
const ctx = await b.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true, acceptDownloads:true });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('  PAGEERROR', e.message));

await p.goto(BASE+'/login',{waitUntil:'networkidle'});
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p.locator('input[type="password"]').first().evaluate((el,v)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));},env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(7000);

// Money → Sales → newest receipt
await p.getByRole('button',{name:'Money',exact:true}).first().click();
await p.waitForTimeout(2500);
await p.locator('button[aria-label="All sales and receipts"]:visible').first().click();
await p.waitForTimeout(3000);
const first = p.locator('[class*="sales-page_row"]:visible').first();
console.log('sales rows:', await p.locator('[class*="sales-page_row"]:visible').count());
await first.click();
await p.waitForTimeout(4000);
await p.screenshot({ path:'shots/receipt-page.png', fullPage:false });

const dl = p.waitForEvent('download', { timeout: 30000 });
await p.locator('button:has-text("Save as PDF"):visible').first().click();
const download = await dl;
await download.saveAs('shots/receipt-sample.pdf');
console.log('saved shots/receipt-sample.pdf');
await b.close();
