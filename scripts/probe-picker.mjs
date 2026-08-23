/** The product picker as a SelectionViewer: looks right, sits above the tabs, closes on back. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE=process.argv[2];
const raw=fs.readFileSync('.env.local','utf8');
const env=k=>(raw.match(new RegExp(`^${k}=(.*)$`,'m'))??[])[1]?.trim().replace(/^"|"$/g,'');
const ok=(n,v,d='')=>console.log(`  ${v?'PASS':'FAIL'}  ${n}${d?' — '+d:''}`);
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2})).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(BASE+'/login',{waitUntil:'networkidle'});
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p.locator('input[type="password"]').first().evaluate((el,v)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));},env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(9000);

const start = p.locator('button:has-text("Start a customer"):visible').first();
if (await start.count()) { await start.click(); await p.waitForTimeout(1200); }
await p.locator('button:has-text("Add an item"):visible').first().click();
await p.waitForTimeout(1800);
await p.screenshot({path:'shots/picker-open.png'});
ok('the picker sheet opened', await p.locator('[class*="react-modal-sheet"]').count() > 0);

await p.locator('input:visible').last().fill('gold');
await p.waitForTimeout(2000);
await p.screenshot({path:'shots/picker-results.png'});
ok('search inside the sheet finds Goldberg', /Goldberg/.test(await p.locator('body').innerText()));

ok('a tap where the tabs are hits the sheet', await p.evaluate(() => {
  const el = document.elementFromPoint(window.innerWidth/2, window.innerHeight-30);
  let n=el; while(n){ if (/react-modal-sheet/.test((n.className||'').toString())) return true; n=n.parentElement; }
  return false;
}));

// The back gesture should dismiss the overlay, not leave the app.
console.log('   before back, url:', p.url().replace(/^https?:\/\/[^/]+/, ''));
await p.goBack();
await p.waitForTimeout(4000);
console.log('   after  back, url:', p.url().replace(/^https?:\/\/[^/]+/, ''));
const closed = await p.locator('[class*="react-modal-sheet"]').count() === 0;
ok('back closes the picker', closed);
const after = await p.locator('body').innerText();
console.log('   after back, page shows:', after.split(String.fromCharCode(10)).filter(Boolean).slice(0,6).join(' | '));
console.log('   nav param:', decodeURIComponent(new URL(p.url()).searchParams.get('nav') || '(none)').slice(0,70));
await p.screenshot({path:'shots/picker-after-back.png'});
ok('and stays on the sell screen', /Add an item|Start a customer/.test(after));
ok('no page errors', errs.length===0, errs.slice(0,1).join(''));
await b.close();
