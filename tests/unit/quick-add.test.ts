/** THE TILL'S ONE BOX — how many, and of what, as the seller types it. */
import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from '@/lib/quick-add';

describe('parseQuickAdd', () => {
  it('takes a leading number as how many, the rest as the search', () => {
    expect(parseQuickAdd('3 b/s')).toEqual({ qty: 3, term: 'b/s' });
    expect(parseQuickAdd('12 goldberg')).toEqual({ qty: 12, term: 'goldberg' });
  });

  it('reads a part, alone or after a whole number', () => {
    expect(parseQuickAdd('½ trophy')).toEqual({ qty: 0.5, term: 'trophy' });
    expect(parseQuickAdd('2½ trophy')).toEqual({ qty: 2.5, term: 'trophy' });
    expect(parseQuickAdd('2 1/2 trophy')).toEqual({ qty: 2.5, term: 'trophy' });
    expect(parseQuickAdd('3/4 fayrouz')).toEqual({ qty: 0.75, term: 'fayrouz' });
  });

  it('is only a search when no number leads, or the number is nothing', () => {
    expect(parseQuickAdd('goldberg')).toEqual({ qty: null, term: 'goldberg' });
    expect(parseQuickAdd('0 b/s')).toEqual({ qty: null, term: '0 b/s' });
    expect(parseQuickAdd('33 export')).toEqual({ qty: 33, term: 'export' });
  });
});
