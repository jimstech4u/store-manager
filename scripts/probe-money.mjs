/** Money → customer statement → receipt, all as pages with back buttons. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE=process.argv[2];
const raw=fs.readFileSync('.env.local','utf8');
const env=k=>(raw.match(new RegExp(`^${k}=(.*)$`,'m'))??[])[1]?.trim().replace(/^"|"$/g,'');
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2})).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const ok=(n,v,d='')=>console.log(`  ${v?'PASS':'FAIL'}  ${n}${d?' — '+d:''}`);

await p.goto(BASE+'/login',{waitUntil:'networkidle'});
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p.locator('input[type="password"]').first().evaluate((el,v)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));},env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(9000);

await p.getByRole('button',{name:'Money',exact:true}).first().click();
await p.waitForTimeout(3000);
await p.screenshot({path:'shots/money-list.png'});

const row = p.locator('[class*="money-page_row"]:visible').first();
ok('a customer row is listed', await row.count() > 0);
await row.click();
await p.waitForTimeout(3000);
await p.screenshot({path:'shots/money-statement.png'});
const t1 = await p.locator('body').innerText();
ok('statement opened as a page', /What makes up this balance/.test(t1));
ok('it has a back button', await p.locator('button[aria-label="Go back"]:visible').count() > 0);

const receiptRow = p.locator('[class*="money-page_row"]:visible').first();
if (await receiptRow.count()) {
  await receiptRow.click();
  await p.waitForTimeout(3500);
  await p.screenshot({path:'shots/money-receipt.png'});
  const t2 = await p.locator('body').innerText();
  ok('a receipt opened from the statement', /Receipt|Total/.test(t2));
  await p.locator('button[aria-label="Go back"]:visible').first().click();
  await p.waitForTimeout(1800);
  ok('back returns to the statement', /What makes up this balance/.test(await p.locator('body').innerText()));
}
ok('no page errors', errs.length===0, errs.slice(0,1).join(''));
await b.close();
