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
await p.waitForTimeout(7000);
await p.getByRole('button',{name:'People',exact:true}).first().click();
await p.waitForTimeout(2500);
const before = await p.evaluate(()=>{
  const b=document.querySelectorAll('[class*="PageScaffold_body"]');
  return [...b].map(e=>({vis:getComputedStyle(e).visibility,disp:getComputedStyle(e).display,op:getComputedStyle(e).opacity,offP:e.offsetParent!==null,rect:Math.round(e.getBoundingClientRect().width)+'x'+Math.round(e.getBoundingClientRect().height)}));
});
console.log('on People:', JSON.stringify(before));
await p.getByRole('button',{name:'Sell',exact:true}).first().click();
await p.waitForTimeout(2500);
const after = await p.evaluate(()=>{
  const b=document.querySelectorAll('[class*="PageScaffold_body"]');
  return [...b].map(e=>({disp:getComputedStyle(e).display,vis:getComputedStyle(e).visibility,offP:e.offsetParent!==null,rect:Math.round(e.getBoundingClientRect().width)+'x'+Math.round(e.getBoundingClientRect().height)}));
});
console.log('on Sell  :', JSON.stringify(after));
// what wraps a stack?
const wrap = await p.evaluate(()=>{
  const el=document.querySelector('[class*="PageScaffold_body"]');
  let n=el, out=[];
  for(let i=0;i<5&&n;i++){ n=n.parentElement; if(!n)break; const cs=getComputedStyle(n);
    out.push({cls:(n.className||'').toString().slice(0,60),disp:cs.display,vis:cs.visibility,pos:cs.position}); }
  return out;
});
console.log('ancestors:', JSON.stringify(wrap,null,1));
await b.close();
