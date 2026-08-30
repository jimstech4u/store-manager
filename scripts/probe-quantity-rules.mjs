/**
 * The quantities a shop may sell in — checked against the cases a shopkeeper described.
 *
 * Pure arithmetic, so it needs no browser and no database. It compiles the real module rather than
 * restating its logic, because a probe that reimplements what it is testing agrees with itself and
 * proves nothing.
 *
 *     node scripts/probe-quantity-rules.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'qty-rules-'));

// The compiler's own entry point rather than `npx`: Node on Windows refuses to spawn a .cmd
// without a shell, and a shell here would only be a way to get quoting wrong.
execFileSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', 'src/lib/quantity-rules.ts', '--outDir', out,
   '--target', 'es2020', '--module', 'es2020',
   // The file is pure arithmetic and pulls in nothing; loading the project's ambient
   // React and Node typings here would only be a way for this probe to fail for reasons
   // that have nothing to do with quantities.
   '--types', '--skipLibCheck'],
  { stdio: 'inherit' },
);

const { partsFor, snapQty, startingQty, isAllowedQty } = await import(
  pathToFileURL(join(out, 'quantity-rules.js')).href
);

const COUNTED = { wholeDigit: true, allowQuarter: false, allowHalf: false, allowThreeQuarter: false };
const HALVES = { ...COUNTED, allowHalf: true };
const QUARTERS = { ...COUNTED, allowQuarter: true };
const THREE_QUARTERS = { ...COUNTED, allowThreeQuarter: true };
const WEIGHED = { ...COUNTED, wholeDigit: false };

let failed = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  — wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
};

console.log('\n— a crate sold whole only —');
check('no part buttons', partsFor(COUNTED).map((p) => p.label), []);
check('starts at one, since there is nothing to ask', startingQty(COUNTED), 1);
check('4.3 crates is 4', snapQty(4.3, COUNTED), 4);
check('4.6 crates is 5', snapQty(4.6, COUNTED), 5);

console.log('\n— halves: the shop sells half a crate —');
check('one button, a half', partsFor(HALVES).map((p) => p.label), ['½']);
check('starts at nothing, so the seller must say', startingQty(HALVES), 0);
check('4.3 becomes 4.5, the figure they reached for', snapQty(4.3, HALVES), 4.5);
check('2.5 stands', snapQty(2.5, HALVES), 2.5);
check('3.5 stands', snapQty(3.5, HALVES), 3.5);
check('4.2 falls back to 4', snapQty(4.2, HALVES), 4);
check('a quarter is not sellable here', isAllowedQty(4.25, HALVES), false);

console.log('\n— quarters: one flag, and halves come with it —');
check('three buttons from one setting', partsFor(QUARTERS).map((p) => p.label), ['¼', '½', '¾']);
check('4.3 becomes 4.25', snapQty(4.3, QUARTERS), 4.25);
check('4.4 becomes 4.5', snapQty(4.4, QUARTERS), 4.5);
check('0.75 is sellable', isAllowedQty(0.75, QUARTERS), true);
check('0.5 is sellable', isAllowedQty(0.5, QUARTERS), true);

console.log('\n— three-quarters —');
check('one button', partsFor(THREE_QUARTERS).map((p) => p.label), ['¾']);
check('a whole one is still sellable', isAllowedQty(1, THREE_QUARTERS), true);
check('1.75 is sellable', isAllowedQty(1.75, THREE_QUARTERS), true);
check('1.5 is not', isAllowedQty(1.5, THREE_QUARTERS), false);

console.log('\n— a chicken on a scale —');
check('no part buttons on a weighed thing', partsFor(WEIGHED), []);
check('starts at nothing: nobody can guess a weight', startingQty(WEIGHED), 0);
check('3.2 kg is left alone', snapQty(3.2, WEIGHED), 3.2);
check('2.22 kg is left alone', snapQty(2.22, WEIGHED), 2.22);
check('any weight is sellable', isAllowedQty(2.22, WEIGHED), true);

console.log('\n— nonsense —');
check('a negative quantity is nothing', snapQty(-3, HALVES), 0);
check('an unfinished number is nothing', snapQty(NaN, HALVES), 0);

rmSync(out, { recursive: true, force: true });

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
