/**
 * THE RECEIPT'S EMPTIES ON PAPER — "Still with you" as out · in · left, and that it fits the roll.
 *
 * Figures are written the shop's way ("3(1/2)") and must fit up to "9999(1/2)" on both 80mm and
 * 58mm rolls (12 Nov). A line wider than the roll is cut off by the printer, mid-figure.
 */
import { describe, expect, it } from 'vitest';
import { columnsAt, defaultLayout, receiptLines } from '@/lib/escpos-text';
import { stillWithYouRows, tableFigure } from '@/lib/receipt-document';
import type { StillWithYouLine } from '@/lib/empties-rollup';

describe('tableFigure', () => {
  it('writes a part the shop\'s way, as one unbroken word', () => {
    expect(tableFigure(3)).toBe('3');
    expect(tableFigure(0.5)).toBe('1/2');
    expect(tableFigure(3.5)).toBe('3(1/2)');
    expect(tableFigure(12.75)).toBe('12(3/4)');
    expect(tableFigure(9999.5)).toBe('9999(1/2)');
  });

  it('never puts a thousands comma in a column', () => {
    expect(tableFigure(1234)).toBe('1234');
  });

  it('writes an odd part as a short number', () => {
    expect(tableFigure(0.0833)).toBe('0.08');
  });
});

describe('stillWithYouRows', () => {
  it('prints nothing when nothing is left', () => {
    expect(stillWithYouRows([])).toEqual([]);
  });

  it('heads the columns out · in · left and lines every figure up under its head', () => {
    const rows = stillWithYouRows([
      { label: 'Nigerian Breweries', unit: 'Crate', out: 8, in: 3, left: 5 },
      { label: 'Goldberg', unit: 'Crate', out: 3.5, in: 0, left: 3.5 },
    ]);
    expect(rows[0]).toMatchObject({ label: 'Still with you', strong: true });
    expect(rows[1].value.trim().split(/\s+/)).toEqual(['out', 'in', 'left']);
    const widths = rows.slice(1).map((r) => r.value.length);
    expect(new Set(widths).size).toBe(1);
    expect(rows[2]).toMatchObject({ label: 'Nigerian Breweries crate' });
    expect(rows[3].value.trim().split(/\s+/)).toEqual(['3(1/2)', '0', '3(1/2)']);
  });
});

/** How much of the roll's width a printed line takes: 1 is the whole width. */
function widestLine(table: StillWithYouLine[], dots: number): number {
  const layout = defaultLayout(dots);
  const lines = receiptLines(
    { shopName: 'S', header: null, footer: null, meta: [], lines: [], totals: stillWithYouRows(table), note: null, transferDetails: null },
    layout,
  );
  const large = columnsAt('sl', layout);
  const small = columnsAt('ss', layout);
  return Math.max(
    ...lines.map((l) => l.spans.reduce((n, s) => n + s.text.length / (s.size.startsWith('ss') ? small : large), 0)),
  );
}

describe('the roll', () => {
  const everyday: StillWithYouLine[] = [
    { label: 'Nigerian Breweries', unit: 'crate', out: 8, in: 3, left: 5 },
    { label: 'Goldberg 60cl', unit: 'crate', out: 3.5, in: 0, left: 3.5 },
  ];
  const huge: StillWithYouLine[] = [
    { label: 'Nigerian Breweries', unit: 'crate', out: 9999.5, in: 9999.5, left: 9999.5 },
    { label: 'Guinness', unit: 'crate', out: 12, in: 0, left: 12 },
  ];

  for (const [roll, dots] of [['80mm', 576], ['58mm', 384]] as const) {
    it(`fits an everyday table on ${roll}`, () => {
      expect(widestLine(everyday, dots)).toBeLessThanOrEqual(1.001);
    });
    it(`fits 9999(1/2) on ${roll}`, () => {
      expect(widestLine(huge, dots)).toBeLessThanOrEqual(1.001);
    });
  }
});
