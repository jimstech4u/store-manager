/**
 * THE PAPER'S TWO COPIES GO STALE TOGETHER (13 Nov) — the logo removed on the printing page kept
 * printing because the till's copy (`store_settings`) never heard. `invalidation.ts` declares them as
 * made from the same row; a write to either reaches both.
 */
import { describe, expect, it, vi } from 'vitest';
import { StateStack } from '@academix-admin/state-stack';
import { invalidate } from '@/lib/stacks/invalidation';

describe('receipt_paper and store_settings', () => {
  it('saving the paper makes the till\'s copy stale', () => {
    const till = vi.fn();
    const off = StateStack.core.onInvalidate('store_settings', till);
    invalidate('receipt_paper');
    expect(till).toHaveBeenCalledTimes(1);
    off();
  });

  it('a settings change heard from another till makes the paper stale', () => {
    const paper = vi.fn();
    const off = StateStack.core.onInvalidate('receipt_paper', paper);
    invalidate('store_settings');
    expect(paper).toHaveBeenCalledTimes(1);
    off();
  });

  it('touches nothing else', () => {
    const other = vi.fn();
    const off = StateStack.core.onInvalidate('catalog', other);
    invalidate('receipt_paper');
    expect(other).not.toHaveBeenCalled();
    off();
  });
});
