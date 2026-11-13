/**
 * THE EMPTIES RULES — arithmetic a customer will argue with across the counter.
 *
 * Whole crates add up across a maker; parts stay with their beer. "Still with you" reads out − in = left
 * on every line. A crate counted back in smaller shapes is never short a can by rounding.
 */
import { describe, expect, it } from 'vitest';
import { joinShapes, splitShapes } from '@/lib/empties-back';
import { rollUpOwed, stillWithYouLines, type OwedRow } from '@/lib/empties-rollup';

const NBL = { groupId: 'nbl', groupName: 'Nigerian Breweries' };
const crate = (productName: string, owed: number, more: Partial<OwedRow> = {}): OwedRow => ({
  productId: productName, productName, productUnitId: `${productName}-crate`, unitName: 'Crate', unitPlural: 'Crates',
  baseQty: 12, groupId: null, groupName: null, owed, ...more,
});

describe('rollUpOwed', () => {
  it('3½ Goldberg and 2½ Gulder is FIVE NBL crates, half a Goldberg and half a Gulder', () => {
    const lines = rollUpOwed([crate('Goldberg', 3.5, NBL), crate('Gulder', 2.5, NBL)]);
    const whole = lines.filter((l) => !l.isPart);
    const parts = lines.filter((l) => l.isPart);
    expect(whole).toHaveLength(1);
    expect(whole[0]).toMatchObject({ label: 'Nigerian Breweries', qty: 5 });
    expect(parts.map((p) => [p.label, p.qty]).sort()).toEqual([['Goldberg', 0.5], ['Gulder', 0.5]]);
  });

  it('adds the same beer up before splitting it: two halves of Goldberg are the crate they hold', () => {
    const lines = rollUpOwed([crate('Goldberg', 0.5, NBL), crate('Goldberg', 0.5, NBL)]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ qty: 1, isPart: false });
  });

  it('never nets what they hold against what we hold', () => {
    const lines = rollUpOwed([crate('Goldberg', 4, NBL), crate('Goldberg', 2, { ...NBL, side: 'we_hold' })]);
    expect(lines.map((l) => [l.side, l.qty]).sort()).toEqual([['they_hold', 4], ['we_hold', 2]]);
  });
});

describe('stillWithYouLines', () => {
  const left = [crate('Gulder', 2, NBL), crate('Star', 2, NBL), crate('Goldberg', 0.5, NBL)];
  const cameIn = [crate('Gulder', 1, NBL)];

  it('by maker: whole crates of a maker are one line, a part keeps its own', () => {
    const lines = stillWithYouLines(left, cameIn, true);
    expect(lines.find((l) => l.label === 'Nigerian Breweries')).toMatchObject({ out: 5, in: 1, left: 4 });
    expect(lines.find((l) => l.label === 'Goldberg')).toMatchObject({ out: 0.5, in: 0, left: 0.5 });
  });

  it('item by item: each beer is its own line', () => {
    const labels = stillWithYouLines(left, cameIn, false).map((l) => l.label).sort();
    expect(labels).toEqual(['Goldberg', 'Gulder', 'Star']);
  });

  it('every line reads out − in = left, and only lines with something left print', () => {
    const lines = stillWithYouLines([crate('Gulder', 1, NBL)], [crate('Gulder', 1, NBL), crate('Trophy', 3)], true);
    for (const l of lines) expect(l.out - l.in).toBeCloseTo(l.left);
    expect(lines.some((l) => l.label === 'Trophy')).toBe(false);
  });
});

describe('splitShapes / joinShapes', () => {
  const cans = [{ name: 'Pack', plural: 'Packs', base: 24 }, { name: 'Can', plural: 'Cans', base: 1 }];

  it('23 of 24 cans is 23 cans, not 22 by rounding (the ledger keeps four places)', () => {
    expect(splitShapes(0.9583, cans)).toEqual([0, 23]);
  });

  it('a crate of 24 with packs of 6: 1 crate, 1 pack, 1 bottle', () => {
    const three = [{ name: 'Crate', plural: 'Crates', base: 24 }, { name: 'Pack', plural: 'Packs', base: 6 }, { name: 'Bottle', plural: 'Bottles', base: 1 }];
    expect(splitShapes(1.2917, three)).toEqual([1, 1, 1]);
  });

  it('goes back to the figure it came from', () => {
    expect(joinShapes([0, 3], [{ name: 'Crate', plural: 'Crates', base: 12 }, { name: 'Bottle', plural: 'Bottles', base: 1 }])).toBe(0.25);
  });
});
