'use client';

import { useMemo, useState } from 'react';
import { useLocation, useNav, useObject } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import {
  recordSupplierEmpties,
  upsertSupplier,
  type Supplier,
} from '@/lib/stacks/suppliers';
import { recordSupplierPayment } from '@/lib/stacks/supplier-money';
import { useSellingUnits } from '@/lib/stacks/selling-units';
import { useProductList } from '@/lib/stacks/catalog-stack';
import { messageOf } from '@/lib/format';
import styles from './supplier-form-page.module.css';

/**
 * Somebody the shop buys from.
 *
 * A FORM, SO A PAGE — the same rule the unit and group forms follow, and for the same reason: a
 * sheet's local state does not survive a rotation, and the keyboard covers the half of it being
 * typed into.
 *
 * NOTHING MAKES THE SHOP LEAVE WHAT IT IS DOING. This is reached from the picker on a half-entered
 * delivery, and the delivery is still there underneath — the alternative is abandoning a load to go
 * and file somebody on a settings screen, which is how a delivery ends up on paper.
 */
export default function SupplierFormPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const { byProduct } = useSellingUnits(store?.id ?? null);
  const { products } = useProductList(store?.id ?? null);

  // Prefilled from whatever was typed into the picker's search: somebody who has just typed "NBL"
  // and been told there is no such supplier should not type it again.
  const [name, setName] = useState((location?.params?.name as string | undefined) ?? '');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');

  /*
   * WHERE THE SHOP STANDS WITH THEM ON DAY ONE.
   *
   * Required with ZERO ACCEPTED, like the customer form: blank and nought are different facts, and
   * a form that takes a blank makes every new supplier silently claim nothing is owed either way.
   */
  const [weOwe, setWeOwe] = useState('');
  const [theyOwe, setTheyOwe] = useState('');

  /*
   * And the containers, both ways, per shape.
   *
   * `we_hold` is their crates standing in the yard; `they_hold` is ours gone out with a load and
   * not back. Two separate obligations that settle separately, which is why they are two boxes and
   * never one net figure.
   */
  const [inYard, setInYard] = useState<Record<string, string>>({});
  const [outWithThem, setOutWithThem] = useState<Record<string, string>>({});
  const [state, setState] = useState<AsyncState>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * Published GLOBALLY under the catalogue scope, and asked for the same way.
   *
   * The unit form got this wrong once by asking without either, which addresses a page-scoped
   * object by its provider's uid and is never found from a pushed page: `isProvided` was quietly
   * false, the callback never ran, and the thing somebody had just created was missing from the
   * picker they came back to.
   */
  const onCreated = useObject<(supplier: Supplier) => void>('onSupplierCreated', {
    global: true,
    scope: 'catalog',
  });

  /*
   * Every shape the shop says comes back — the only ones a container obligation can exist in.
   *
   * Read from `product_selling_units`, which is already loaded store-wide, so opening this form
   * costs no request of its own.
   */
  const returnable = useMemo(() => {
    const named = new Map(products.map((p) => [p.id, p.name]));
    const out: { productUnitId: string; label: string }[] = [];
    for (const [productId, shapes] of byProduct) {
      for (const sh of shapes) {
        /*
         * THE SHAPE IT ARRIVES IN, not every shape that comes back.
         *
         * A brewery delivers in crates and takes crates back on the same lorry. It has never seen
         * the bottles on their own, so offering "Goldberg bottles" on a supplier's opening position
         * is asking a question the shop cannot answer about a party that does not deal in them.
         *
         * The customer side asks the opposite question and uses `isCounted` — see
         * `customer-form-page`.
         */
        if (!sh.isReturnable || !sh.isBought) continue;
        out.push({
          productUnitId: sh.productUnitId,
          label: `${named.get(productId) ?? 'Item'} ${sh.plural.toLowerCase()}`,
        });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [byProduct, products]);

  if (!store) return null;

  const save = async () => {
    setState('busy');
    setProblem(null);
    try {
      const id = await upsertSupplier({
        storeId: store.id,
        name: name.trim(),
        phone: phone.trim(),
        note: note.trim(),
      });

      /*
       * WHERE THEY STAND, written after the supplier exists.
       *
       * Money first, then containers, and each its own row — the ledgers are separate because they
       * settle separately, on different days, by different people.
       */
      if (Number(weOwe) > 0) {
        await recordSupplierPayment({
          storeId: store.id,
          supplierId: id,
          amount: Number(weOwe),
          direction: 'charge',
          reason: 'What we already owed when the account opened',
        });
      }
      if (Number(theyOwe) > 0) {
        await recordSupplierPayment({
          storeId: store.id,
          supplierId: id,
          amount: Number(theyOwe),
          direction: 'credit',
          reason: 'What they already owed us when the account opened',
        });
      }

      for (const sh of returnable) {
        const theirs = Number(inYard[sh.productUnitId]);
        if (theirs > 0) {
          await recordSupplierEmpties({
            storeId: store.id,
            supplierId: id,
            productUnitId: sh.productUnitId,
            qty: theirs,
            side: 'we_hold',
            direction: 'out',
            note: 'Already in the yard when the account opened',
          });
        }
        const ours = Number(outWithThem[sh.productUnitId]);
        if (ours > 0) {
          await recordSupplierEmpties({
            storeId: store.id,
            supplierId: id,
            productUnitId: sh.productUnitId,
            qty: ours,
            side: 'they_hold',
            direction: 'out',
            note: 'Already out with them when the account opened',
          });
        }
      }

      /*
       * Handed back as a whole row, not an id.
       *
       * A supplier named ten seconds ago has no deliveries against it — saying so is the only
       * correct answer, not a guess. The server returns the EXISTING id when the name is already
       * taken, and joining that one is right: a shop that forgot it already had NBL gets NBL.
       */
      if (onCreated.isProvided) {
        const notify = onCreated.getter();
        if (notify) {
          notify({
            id,
            name: name.trim(),
            phone: phone.trim() || null,
            note: note.trim() || null,
            status: 'active',
            deliveries: 0,
            lastAt: null,
          });
        }
      }
      setState('idle');
      void nav.pop();
    } catch (e) {
      setState('failed');
      setProblem(messageOf(e, 'Could not save that supplier.'));
    }
  };

  return (
    <PageScaffold onBack={goBack} title="Add a supplier" subtitle="Whoever you buy from">
      <Explain label="Why keep a supplier?">
        So a delivery and the crates that go back on the same lorry both belong to somebody. Written
        as free text, &ldquo;NBL&rdquo; and &ldquo;Nigerian Breweries&rdquo; are two different
        suppliers and neither has a history.
      </Explain>

      <Field
        label="What are they called?"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Nigerian Breweries"
        hint="However you say it when the lorry arrives."
      />

      <Field
        label="Phone number"
        optional
        type="tel"
        inputMode="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="0803 000 0000"
        hint="Who to ring when a load is short."
      />

      <Field
        label="Note"
        optional
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Delivers Tuesdays"
      />

      <h2 className={styles.section}>Where you stand with them</h2>
      <p className={styles.sectionNote}>
        From your book, if you have been buying from them already. Leave a nought where there is
        nothing — &ldquo;none&rdquo; and &ldquo;nobody checked&rdquo; are different answers.
      </p>

      <Field
        label="You already owe them"
        numeric
        prefix="₦"
        value={weOwe}
        onChange={(e) => setWeOwe(e.target.value)}
        placeholder="0"
      />

      <Field
        label="They already owe you"
        numeric
        prefix="₦"
        value={theyOwe}
        onChange={(e) => setTheyOwe(e.target.value)}
        placeholder="0"
        hint="A rebate, or a load you sent back and have not been credited for."
      />

      {returnable.length > 0 && (
        <>
          <h3 className={styles.subsection}>Their containers in your yard</h3>
          <p className={styles.sectionNote}>
            Crates and bottles of theirs standing here, waiting for a lorry.
          </p>
          <div className={styles.shapeBoxes}>
            {returnable.map((sh) => (
              <Field
                key={`in-${sh.productUnitId}`}
                label={sh.label}
                numeric
                value={inYard[sh.productUnitId] ?? ''}
                onChange={(e) =>
                  setInYard((prev) => ({ ...prev, [sh.productUnitId]: e.target.value }))
                }
                placeholder="0"
              />
            ))}
          </div>

          <h3 className={styles.subsection}>Your containers out with them</h3>
          <p className={styles.sectionNote}>
            Yours that went out on a load and have not come back.
          </p>
          <div className={styles.shapeBoxes}>
            {returnable.map((sh) => (
              <Field
                key={`out-${sh.productUnitId}`}
                label={sh.label}
                numeric
                value={outWithThem[sh.productUnitId] ?? ''}
                onChange={(e) =>
                  setOutWithThem((prev) => ({ ...prev, [sh.productUnitId]: e.target.value }))
                }
                placeholder="0"
              />
            ))}
          </div>
        </>
      )}

      {/* The action ENDS the page rather than being pinned to its foot — see CLAUDE.md. */}
      <div className={styles.actions}>
        <AsyncAction state={state} problem={problem} label="Saving this supplier">
          <Button onClick={() => void save()} disabled={name.trim() === ''} fullWidth>
            Add them
          </Button>
        </AsyncAction>
      </div>
    </PageScaffold>
  );
}
