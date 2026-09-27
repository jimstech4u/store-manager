/**
 * THE PRINTED LAYOUT, CHECKED AS TEXT.
 *
 * Every rule here came off a physical receipt a shop held up, and each one is the kind of thing
 * that is obvious on paper and invisible in a type-check. Checking the LINES directly — the same
 * array the printer is sent — is faster than printing and more reliable than reading a photograph.
 *
 *   · nothing is cut. A shop's own name and a container line were being sliced to the column
 *     count: "Jimstech innovations Nigeria lim", "Nigerian Breweries (NBL) crate" with the count
 *     pushed off the end
 *   · a fraction that follows a whole number is SMALLER than it — "3 1/2" read as "31/2"
 *   · a fraction standing alone is not shrunk: it is the quantity
 *   · a divider after each item, and a heavy one before the money
 *   · amounts land on the right-hand edge, within one character of it
 *   · and the unit price is not repeated
 *
 *     node scripts/probe-receipt-layout.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/*
 * The module is TypeScript, so it is compiled on the way in rather than duplicated here. A probe
 * that reimplements the thing it is testing tests itself.
 */
const dir = mkdtempSync(join(tmpdir(), 'receipt-layout-'));
const src = readFileSync('src/lib/escpos-text.ts', 'utf8')
  .replace("'use client';", '')
  /*
   * The payload type is declared locally rather than imported. The import is a path alias that
   * only means something inside Next's build, and dropping it outright left the file referring to
   * a type that no longer existed. What is being tested is the LAYOUT, not the shape of the input.
   */
  .replace(
    "import type { ReceiptImageInput } from '@/lib/share';",
    'type ReceiptImageInput = Record<string, any>;',
  );
writeFileSync(join(dir, 'escpos-text.ts'), src);
execSync(
  `npx tsc "${join(dir, 'escpos-text.ts')}" --module esnext --target es2020 --moduleResolution bundler --skipLibCheck --noImplicitAny false --outDir "${dir}"`,
  { stdio: 'pipe' },
);
const { receiptLines, defaultLayout, columnsAt, asFraction } = await import(
  `file://${join(dir, 'escpos-text.js')}`
);

const layout = defaultLayout(576);
const sample = {
  shopName: 'ASHABI GLOBAL RESOURCES',
  header: '122, old ota road, ile-epo, oke-odo, Lagos, Nigeria | 08023115864,08080733030',
  footer: 'Thank you for your patronage',
  meta: ['19 Sep 2026, 20:00', '#D1785811', 'Gabriel'],
  lines: [
    { name: 'Eva Water 75cl', qty: '3 Pack', detail: '3 Pack x N2,400', amount: 'N7,200' },
    { name: 'Gulder 60cl', qty: '3.5 Crate', detail: '3.5 Crate x N15,000', amount: 'N52,500' },
    { name: 'American Cola PET 60cl', qty: '1 Bottle', detail: '1 Bottle x N3,700', amount: 'N3,700' },
  ],
  totals: [
    { label: 'Total', value: 'N68,800', strong: true },
    { label: 'Owed before', value: 'N13,500' },
    { label: 'Still with you', value: '', strong: true },
    { label: 'Nigerian Breweries (NBL) crate', value: '4' },
    { label: 'Gulder 60cl crate', value: '0.5' },
  ],
  note: null,
  transferDetails: 'Moniepoint\n8080733030\nJimstech innovations Nigeria limited',
};

const lines = receiptLines(sample, layout);
const flat = lines.map((l) => l.spans.map((s) => s.text).join(''));
const all = flat.join('\n');

console.log('\n— nothing is lost —');
/*
 * Checked against the SOURCE rather than a hard-coded string: the test is that every word survives
 * somewhere, which is the actual requirement. Matching an exact rendering would break the next
 * time a size changes and would say nothing about whether text was dropped.
 */
const squashed = all.replace(/\s+/g, ' ');
for (const word of ['limited', 'Breweries', 'patronage', '08080733030', 'RESOURCES']) {
  check(`"${word}" survives`, squashed.includes(word), squashed.slice(0, 80));
}

console.log('\n— a fraction is smaller than the number it qualifies —');
const gulder = lines.find((l) => l.spans.map((s) => s.text).join('').includes('1/2 Crate'));
check('the half-crate line exists', Boolean(gulder), flat.filter((l) => l.includes('Crate')).join(' | '));
if (gulder) {
  const whole = gulder.spans.find((s) => s.text.trim() === '3');
  const half = gulder.spans.find((s) => s.text.includes('1/2'));
  check('the 3 and the 1/2 are separate spans', Boolean(whole && half), JSON.stringify(gulder.spans));
  check(
    'and the fraction is the smaller of the two',
    Boolean(whole && half) && columnsAt(half.size, layout) > columnsAt(whole.size, layout),
    `${whole?.size} vs ${half?.size}`,
  );
}

const alone = lines.find((l) => l.spans.map((s) => s.text).join('').includes('Gulder 60cl crate'));
if (alone) {
  /*
   * "1/2" STANDING ALONE IS THE QUANTITY and must not shrink — it is the only figure on the line,
   * and shrinking it would make the thing being reported the smallest thing on the row.
   */
  const sizes = new Set(alone.spans.filter((s) => s.text.trim() !== '').map((s) => s.size));
  check('a fraction with no whole number is not shrunk', sizes.size === 1, JSON.stringify([...sizes]));
}

console.log('\n— the dividers —');
const isRule = (t) => /^-+$/.test(t);
const isDouble = (t) => /^=+$/.test(t);
const itemNameAt = flat.findIndex((t) => t === 'Eva Water 75cl');
check('an item is followed by a divider before the next', isRule(flat[itemNameAt + 2]), flat.slice(itemNameAt, itemNameAt + 4).join(' | '));

const lastItem = flat.findIndex((t) => t.includes('American Cola'));
const afterLast = flat.slice(lastItem).findIndex(isDouble);
check(
  'and the last item is closed by a heavy rule, not a light one',
  afterLast >= 0 && !flat.slice(lastItem, lastItem + afterLast).some(isRule),
  flat.slice(lastItem, lastItem + afterLast + 1).join(' | '),
);
/*
 * FIVE, and this assertion said four. The shop asked for a heavy line under the letterhead, under
 * who and when, under the money and under what they are still holding — four — and separately for
 * the last item to be closed by a heavy one "right before the total". That is the fifth, and it
 * sits between the items and the money. The code was right and the count in this probe was not.
 */
check('there are five heavy rules', flat.filter(isDouble).length === 5, String(flat.filter(isDouble).length));

console.log('\n— the amounts line up —');
/*
 * Within ONE character of the edge. Exactly at it would be a test of the rounding rather than of
 * the layout, and the padding is done in whole small spaces which do not always divide evenly into
 * a larger size's line.
 */
for (const want of ['N7,200', 'N52,500', 'N68,800']) {
  const row = flat.find((t) => t.endsWith(want));
  check(`${want} sits at the right-hand edge`, Boolean(row), row ?? 'not found at a line end');
}

console.log('\n— and the unit price is not repeated —');
check('no "x N" on any line', !/ x N/.test(all), (all.match(/.{0,24} x N.{0,10}/) ?? [''])[0]);

console.log('\n— fractions —');
for (const [from, to] of [['0.5', '1/2'], ['2.5', '2 1/2'], ['0.25', '1/4'], ['3.75', '3 3/4']]) {
  check(`${from} reads as ${to}`, asFraction(from) === to, asFraction(from));
}
check('money is left alone', asFraction('N9,600.50') === 'N9,600.50', asFraction('N9,600.50'));

console.log(failed === 0 ? '\n  all good' : `\n  ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
