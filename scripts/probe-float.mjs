/** The pinned bottom bars are gone; the sell total rides the tab bar. Photograph and measure it. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE=process.argv[2];
const raw=fs.readFileSync('.env.local','utf8');
const env=k=>(raw.match(new RegExp(`^${k}=(.*)$`,'m'))??[])[1]?.trim().replace(/^"|"$/g,'');
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2})).newPage();
await p.goto(BASE+'/login',{waitUntil:'networkidle'});
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p.locator('input[type="password"]').first().evaluate((el,v)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));},env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(9000);

const start = p.locator('button:has-text("Start a customer"):visible').first();
if (await start.count()) { await start.click(); await p.waitForTimeout(1200); }
await p.locator('button:has-text("Add an item"):visible').first().click();
await p.waitForTimeout(1000);
await p.locator('input:visible').last().fill('coca');
await p.waitForTimeout(1800);
await p.locator('[class*="pickItem"]:visible').first().click();
await p.waitForTimeout(1800);

const measure = async (label) => {
  const m = await p.evaluate(() => {
    const nav = document.querySelector('nav.navigation-bar');
    // NOT `offsetParent`: a position:fixed element reports null for it, so the earlier test said
    // the pill was absent while it was on screen the whole time.
    const pay = [...document.querySelectorAll('button')]
      .find(b => /Take payment|Fix the quantity/.test(b.textContent) && b.getBoundingClientRect().height > 0);
    const fab = document.querySelector('.fab');
    const r = e => { const x=e.getBoundingClientRect(); return {top:Math.round(x.top),bottom:Math.round(x.bottom)}; };
    return { vh: window.innerHeight,
             nav: nav ? { ...r(nav), transform: getComputedStyle(nav).transform } : null,
             pay: pay ? r(pay) : null,
             fab: fab ? r(fab) : null };
  });
  console.log(`  ${label.padEnd(20)} ${JSON.stringify(m)}`);
  return m;
};

const atRest = await measure('at rest');
console.log('  total visible without opening anything:',
  await p.locator('button:has-text("Take payment"):visible').first().innerText());
await p.screenshot({path:'shots/float-sell.png'});

// Scroll down: the bar hides and the floating total should travel with it.
await p.evaluate(()=>{const c=[...document.querySelectorAll('[class*="PageScaffold_body"]')].find(e=>e.offsetParent&&e.scrollHeight>e.clientHeight); if(c)c.scrollTop=600;});
await p.waitForTimeout(1200);
const scrolled = await measure('scrolled down');
await p.screenshot({path:'shots/float-sell-scrolled.png'});
console.log('  total moved with the bar:', atRest.pay && scrolled.pay && scrolled.pay.top !== atRest.pay.top);

// Pinned footers gone elsewhere.
for (const tab of ['Stock','People']) {
  await p.evaluate(()=>document.querySelectorAll('[class*="PageScaffold_body"]').forEach(c=>{c.scrollTop=0;}));
  await p.waitForTimeout(800);
  await p.getByRole('button',{name:tab,exact:true}).first().click();
  await p.waitForTimeout(2200);
  const footer = await p.locator('[class*="PageScaffold_footer"]:visible').count();
  console.log(`  ${tab}: pinned footer count = ${footer} (want 0)`);
  await p.screenshot({path:`shots/float-${tab.toLowerCase()}.png`});
}
await b.close();
