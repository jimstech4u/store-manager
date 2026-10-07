'use client';

import { useCallback, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { ConfirmDialog, useConfirm, ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { fetchProduct } from '@/lib/stacks/catalog-stack';
import { usePermission } from '@/hooks/usePermission';

/**
 * NOTHING THE RECORDS SAY IS FINISHED GOES ONTO A SALE WITHOUT SOMEBODY LOOKING.
 *
 * "When we want to sell an item that has 0, it does not get added: a dialog says it is finished,
 * they should confirm physically, and they can count it and correct it the way the count gate does."
 *
 * Every place an item is put on a sale asks `allow(product)` first — the till, a correction, Take
 * payment, All items — whether it came from the picker, a barcode or a new item just made. The
 * figure is read FRESH from the server (`get_product`), never the picker's row: another till may have
 * sold the last crate a minute ago, or a delivery landed.
 *
 * At nothing (or below), the item is not added. The dialog says so and offers "Count it": the
 * item's own count entry, the normal count. If the shelf has some, the count finds more than the
 * records and asks why — "It came in, but was never entered" puts it on the records — and the item
 * can then be added.
 *
 * `putBack` is what this sale already holds of the item, for a correction: correcting a receipt puts
 * its old lines back on the shelf first, so a receipt that sold the last crate may still say it.
 *
 * A READ THAT FAILS DOES NOT STOP A SALE. This is the shop's own check, not the ledger's rule — the
 * server will record a sale below nothing — so with no answer the item goes on as it always has.
 */
export function useFinishedGuard() {
  const nav = useNav();
  const { canOpen } = usePermission();
  const ask = useConfirm();
  const told = useProblem();
  const showTold = told.show;
  const [finished, setFinished] = useState<{ id: string; name: string } | null>(null);
  const mayCount = canOpen('count_entry_page');

  const allow = useCallback(
    async (product: { id: string; name: string }, putBack = 0): Promise<boolean> => {
      let onHand: number | null = null;
      try {
        const fresh = await fetchProduct(product.id);
        onHand = fresh ? Number(fresh.onHand) : null;
      } catch {
        onHand = null;
      }
      if (onHand == null || !Number.isFinite(onHand) || onHand + putBack > 0.0001) return true;
      if (mayCount) {
        setFinished({ id: product.id, name: product.name });
      } else {
        showTold(
          `${product.name} is finished — the records say there is none left. Check the shelf, and ` +
            'if there is some, ask somebody who counts stock to count it.',
        );
      }
      return false;
    },
    [mayCount, showTold],
  );

  const dialog = (
    <>
      {finished && (
        <ConfirmDialog
          controller={ask}
          title={`${finished.name} is finished`}
          message={
            'The records say there is none left, so it was not added. Check the shelf. If there is ' +
            'some, count it — the count puts the records right — then add it again.'
          }
          confirmText="Count it"
          cancelText="Not now"
          tone="primary"
          onDismiss={() => setFinished(null)}
          onConfirm={() => {
            const id = finished.id;
            setFinished(null);
            void nav.push('count_entry_page', { id });
          }}
        />
      )}
      <ProblemDialog problem={told} title="This item is finished" />
    </>
  );

  return { allow, dialog };
}
