/**
 * HOW THE AGENT READS AN ORDER LIST — the lines the shop really sent (12 Nov chats).
 *
 * The matching itself needs the database (scripts/probe-whatsapp-dcc.mjs); reading a line, splitting
 * it, turning single ones into a part of a crate, and whether a written name fits an item do not.
 */
import { describe, expect, it } from 'vitest';
import type { Shape } from '@/lib/whatsapp/actions';
import { fits, listFromText, readLine, shapeFor, splitPairs } from '@/lib/whatsapp/orders';

const read = (text: string, who: string | null = null) => listFromText(text, who).map((l) => [l.n, l.name, l.qty, l.unit]);

const shape = (unit_name: string, base_qty: number, more: Partial<Shape> = {}): Shape => ({
  product_id: 'p', product_unit_id: unit_name, unit_name, unit_plural: `${unit_name}s`, base_qty,
  is_default: false, is_returnable: false, price_per_unit: 1, whole_digit: true, ...more,
});

describe('readLine', () => {
  it('takes the number at either end as how many', () => {
    expect(readLine({ written: 'Goldberg 2' })).toMatchObject({ name: 'Goldberg', qty: 2 });
    expect(readLine({ written: '2 Mr V' })).toMatchObject({ name: 'Mr V', qty: 2 });
    expect(readLine({ written: 'Laqua - 20' })).toMatchObject({ name: 'Laqua', qty: 20 });
    expect(readLine({ written: 'Turbo - 1/2' })).toMatchObject({ name: 'Turbo', qty: 0.5 });
  });

  it('reads a fraction in front as the fraction ("1/4 Fayrouz" was 1 of "/4 Fayrouz")', () => {
    expect(readLine({ written: '1/4 Fayrouz' })).toMatchObject({ name: 'Fayrouz', qty: 0.25 });
    expect(readLine({ written: '0.5 golberg bottle' })).toMatchObject({ name: 'golberg bottle', qty: 0.5 });
  });

  it('keeps "pcs" as single ones, even when the model passed only the name and the number', () => {
    expect(readLine({ written: 'Desperado - 5pcs' })).toMatchObject({ name: 'Desperado', qty: 5, unit: 'piece' });
    expect(readLine({ written: 'Desperado - 5pcs', name: 'Desperado', qty: 5 })).toMatchObject({ unit: 'piece' });
    expect(readLine({ written: 'fayrous - 6 pcs' })).toMatchObject({ name: 'fayrous', qty: 6, unit: 'piece' });
  });

  it('leaves a shape said last to the search: it may be the item\'s own name', () => {
    expect(readLine({ written: 'Malta Guiness can 1' })).toMatchObject({ name: 'Malta Guiness can', qty: 1, unit: null });
    expect(readLine({ written: '½ crate trophy' })).toMatchObject({ name: 'trophy', qty: 0.5, unit: 'crate' });
  });
});

describe('splitPairs', () => {
  it('splits a line that is only name-and-number pairs', () => {
    expect(splitPairs('Mr v 30 American cooler 20')).toEqual(['Mr v 30', 'American cooler 20']);
    expect(splitPairs('Goldberg 2, Star 3')).toEqual(['Goldberg 2', 'Star 3']);
  });

  it('leaves one item alone, numbers in its name and all', () => {
    expect(splitPairs('Goldberg 600ml 2')).toEqual(['Goldberg 600ml 2']);
    expect(splitPairs('2 Mr V')).toEqual(['2 Mr V']);
    expect(splitPairs('33 export 2')).toEqual(['33 export 2']);
  });
});

describe('listFromText', () => {
  it('drops who it is for, in front of the first item or as a heading', () => {
    expect(read('For olaoluwa Mr v 30 American cooler 20', 'Olaoluwa')).toEqual([
      [null, 'Mr v', 30, null],
      [null, 'American cooler', 20, null],
    ]);
    expect(read('For DCC\nTurbo - 1/2', 'Dcc')).toEqual([[null, 'Turbo', 0.5, null]]);
    expect(read("Valuemart's order\nGoldberg 2")).toEqual([[null, 'Goldberg', 2, null]]);
  });

  it('keeps the numbers of numbered answers, through WhatsApp\'s invisible joiners', () => {
    expect(read('1. 0.5 golberg bottle \n2. ⁠0.5 trophy stout \n3. ⁠1/4 Fayrouz \n4. ⁠2 Mr V')).toEqual([
      [1, 'golberg bottle', 0.5, null],
      [2, 'trophy stout', 0.5, null],
      [3, 'Fayrouz', 0.25, null],
      [4, 'Mr V', 2, null],
    ]);
  });
});

describe('shapeFor', () => {
  const crateOf20 = [shape('Bottle', 1, { is_sold: false }), shape('Crate', 20, { is_default: true, allow_half: true, allow_quarter: true })];

  it('turns single ones into the part of a crate they make (DCC: 5pcs of Desperado was ¼ crate, not 5 crates)', () => {
    const got = shapeFor('Desperado', crateOf20, 'piece', 5);
    expect('shape' in got && got.shape.unit_name).toBe('Crate');
    expect('qty' in got && got.qty).toBe(0.25);
  });

  it('asks when the single ones are no part it sells', () => {
    expect(shapeFor('Desperado', crateOf20, 'piece', 7)).toHaveProperty('why');
  });

  it('sells single ones as themselves when the item sells them', () => {
    const got = shapeFor('Mr V', [shape('Piece', 1), shape('Pack', 12, { is_default: true })], 'piece', 2);
    expect('shape' in got && got.shape.unit_name).toBe('Piece');
    expect('qty' in got && got.qty).toBe(2);
  });

  it('refuses a shape the item is not sold in', () => {
    expect(shapeFor('Desperado', crateOf20, 'carton', 1)).toHaveProperty('why');
  });
});

describe('fits', () => {
  it('lets a misspelt or run-together name through', () => {
    expect(fits('golberg bottle', 'Goldberg Bottle (600mL)')).toBe(true);
    expect(fits('Flyfish', 'Flying Fish Bottle (420mL)')).toBe(true);
    expect(fits('fayrous', 'Fayrouz Bottle (330mL)')).toBe(true);
    expect(fits('Lakasera', 'La Casera PET')).toBe(true);
    expect(fits('Turbo', 'Turbo King Bottle (60cl)')).toBe(true);
  });

  it('does not let a lone search hit stand for a name it hardly fits ("Bln" went on as Berry Blast)', () => {
    expect(fits('Bln', 'Berry Blast (78CL)')).toBe(false);
  });
});
