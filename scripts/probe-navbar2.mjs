/** Autohide has two halves: away on a downward scroll, back on an upward one. Check both. */
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
await p.waitForTimeout(8000);
await p.getByRole('button',{name:'Stock',exact:true}).first().click();
await p.waitForTimeout(3000);

const t = async (label) => {
  const v = await p.evaluate(() => {
    const nav = document.querySelector('nav.navigation-bar');
    return nav ? getComputedStyle(nav).transform : 'no nav';
  });
  console.log(`  ${label.padEnd(22)} ${v}`);
};
const scrollTo = async (y) => {
  await p.evaluate((top) => {
    const c = [...document.querySelectorAll('[class*="PageScaffold_body"]')]
      .find((e) => e.offsetParent !== null && e.scrollHeight > e.clientHeight);
    if (c) c.scrollTop = top;
  }, y);
  await p.waitForTimeout(900);
};

await t('at rest');
await scrollTo(300); await t('scrolled down 300');
await scrollTo(600); await t('scrolled down 600');
await scrollTo(200); await t('scrolled UP to 200');
await scrollTo(0);   await t('back at top');
await b.close();
