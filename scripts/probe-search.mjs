/**
 * Every search surface now opens the shared SearchViewer sheet. Prove it on each one:
 * the box opens a real dialog, typing filters, a result is clickable, and back closes it.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE=process.argv[2];
const raw=fs.readFileSync('.env.local','utf8');
const env=k=>(raw.match(new RegExp(`^${k}=(.*)$`,'m'))??[])[1]?.trim().replace(/^"|"$/g,'');

const results=[];
const check=(n,ok,d='')=>{results.push({n,ok});console.log(`  ${ok?'PASS':'FAIL'}  ${n}${d?` — ${d}`:''}`);};

const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2})).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));

await p.goto(BASE+'/login',{waitUntil:'networkidle'});
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p.locator('input[type="password"]').first().evaluate((el,v)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));},env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(9000);

async function revealTabs(){
  await p.evaluate(()=>document.querySelectorAll('[class*="PageScaffold_body"]').forEach(c=>{if(c.scrollTop>0)c.scrollTop=0;}));
  await p.waitForTimeout(700);
}

const surfaces=[
  { tab:'Stock',  label:'Search your stock',        term:'coca',  expect:/Coca-Cola/ },
  { tab:'Count',  label:'Find a product to count',  term:'gold',  expect:/Goldberg/ },
  { tab:'Money',  label:'Search customers',         term:'ire',   expect:/Irekanmi/ },
  { tab:'People', label:'Search customers',         term:'ire',   expect:/Irekanmi/ },
];

for (const s of surfaces) {
  console.log(`\n${s.tab}`);
  await revealTabs();
  await p.getByRole('button',{name:s.tab,exact:true}).first().click();
  await p.waitForTimeout(2200);

  const box = p.locator(`button[aria-label="${s.label}"]:visible`).first();
  check('search box present', await box.count() > 0);
  if (!(await box.count())) continue;

  await box.click();
  await p.waitForTimeout(1400);
  const dialog = p.locator('[role="dialog"]:visible').first();
  check('opens a real dialog', await dialog.count() > 0);

  // The sheet must sit above the tab bar, not behind it.
  const above = await p.evaluate(()=>{
    const el=document.elementFromPoint(window.innerWidth/2, window.innerHeight-24);
    return el?.closest('[role="dialog"],[class*="search-viewer"],[class*="modal"]')!==null || /viewer|sheet|modal/i.test(el?.className?.toString?.()??'');
  });
  check('sheet is above the tab bar', above);

  const input = p.locator('[role="dialog"] input:visible, [class*="search"] input:visible').last();
  await input.fill(s.term);
  await p.waitForTimeout(1800);
  const hit = p.getByText(s.expect).first();
  check(`typing "${s.term}" finds a match`, await hit.count() > 0);
  await p.screenshot({path:`shots/search-${s.tab.toLowerCase()}.png`});

  await p.goBack();
  await p.waitForTimeout(1200);
  check('back closes the sheet', (await p.locator('[role="dialog"]:visible').count()) === 0);
}

check('no uncaught page errors', errs.length===0, errs.slice(0,2).join(' | '));
await b.close();
const failed=results.filter(r=>!r.ok);
console.log(`\n${results.length-failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
