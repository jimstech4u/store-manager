/** Open the new search sheet from the stock page and check it works and sits above the tab bar. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE=process.argv[2];
const raw=fs.readFileSync('.env.local','utf8');
const env=k=>(raw.match(new RegExp(`^${k}=(.*)$`,'m'))??[])[1]?.trim().replace(/^"|"$/g,'');
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2})).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(BASE+'/login',{waitUntil:'networkidle'});
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p.locator('input[type="password"]').first().evaluate((el,v)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));},env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(9000);
await p.getByRole('button',{name:'Stock',exact:true}).first().click();
await p.waitForTimeout(2800);
await p.screenshot({path:'shots/search-stock-page.png'});

const launcher = p.locator('button[aria-label="Search your stock"]:visible').first();
console.log('launcher present:', await launcher.count());
await launcher.click();
await p.waitForTimeout(1800);
await p.screenshot({path:'shots/search-open.png'});

const input = p.locator('input:visible').last();
await input.fill('water');
await p.waitForTimeout(2200);
await p.screenshot({path:'shots/search-results.png'});
const txt = await p.locator('body').innerText();
console.log('shows Eva:', /Eva Water/.test(txt));

// Does the sheet win over the tab bar?
console.log('tap over the tab bar hits:', await p.evaluate(() => {
  const el = document.elementFromPoint(window.innerWidth/2, window.innerHeight-30);
  let n=el, path=[];
  while(n && path.length<4){ path.push((n.className||'').toString().slice(0,28)||n.tagName); n=n.parentElement; }
  return path.join(' < ');
}));
console.log('errors:', errs.slice(0,2));
await b.close();
