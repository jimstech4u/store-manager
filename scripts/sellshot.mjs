import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE=process.argv[2];
const raw=fs.readFileSync('.env.local','utf8');
const env=k=>(raw.match(new RegExp(`^${k}=(.*)$`,'m'))??[])[1]?.trim().replace(/^"|"$/g,'');
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})).newPage();
await p.goto(BASE+'/login',{waitUntil:'networkidle'});
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p.locator('input[type="password"]').first().evaluate((el,v)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));},env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(9000);
console.log(JSON.stringify(await p.evaluate(() => {
  const body = [...document.querySelectorAll('[class*="PageScaffold_body"]')].find(e=>e.offsetParent!==null);
  const btn = [...document.querySelectorAll('button')].find(e=>e.offsetParent!==null && /Add an item/.test(e.textContent));
  const r = e => { const x=e.getBoundingClientRect(); return {top:Math.round(x.top),bottom:Math.round(x.bottom),h:Math.round(x.height)}; };
  return { vh: window.innerHeight,
           body: body ? {...r(body), scrollH: body.scrollHeight, clientH: body.clientHeight} : null,
           addItem: btn ? r(btn) : null };
}), null, 1));
await p.screenshot({path:'shots/sell-after-scaffold.png'});
await b.close();
