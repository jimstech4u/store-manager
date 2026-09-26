'use client';

import { useEffect, useState } from 'react';
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
  recordSupplierGroupEmpties,
  upsertSupplier,
  type Supplier,
} from '@/lib/stacks/suppliers';
import {
  groupReturnUnits,
  groupsWithReturnables,
  productsWithReturnables,
  type GroupUnit,
  type ReturnableGroup,
  type ReturnableProduct,
} from '@/lib/stacks/customer-ledgers';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { recordSupplierPayment } from '@/lib/stacks/supplier-money';
import { useSellingUnits } from '@/lib/stacks/selling-units';
import { messageOf } from '@/lib/format';
import styles from './supplier-form-page.module.css';

/**
 * ONE LINE OF CONTAINERS, at whichever grain the shop entered it.
 *
 * It carries both the ids the writer needs and the words the person checking the form reads,
 * because they are different things: the writer wants a category or a shape id, and the shop wants
 * to see "25 NBL crates".
 */
interface SupplierEmptyLine {
  key: string;
  side: 'we_hold' | 'they_hold';
  qty: number;
  label: string;
  /** Exactly one of these two pairs is set — the same rule the table now enforces. */
  categoryId?: string;
  storeUnitId?: string;
  productUnitId?: string;
}

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
   * THE CONTAINERS, AS LINES — not a numbered box for every shape the shop has ever sold.
   *
   * This was two grids, each with one box per returnable shape: a screen of thirty zeroes to
   * record the one number the shop actually knows. And it could only speak in shapes, so
   * "25 NBL crates" — which is how a yard is really settled, because nobody records which beer was
   * in which crate — could not be entered at all.
   *
   * Now the same thing the customer form does: choose a maker or an item, say how many, add a
   * line. `we_hold` is their crates standing in the yard; `they_hold` is ours gone out on a load
   * and not back. Two obligations that settle separately, which is why the side is chosen per line
   * and never netted into one figure.
   */
  const [lines, setLines] = useState<SupplierEmptyLine[]>([]);
  const [side, setSide] = useState<'we_hold' | 'they_hold'>('we_hold');
  const [tab, setTab] = useState<'group' | 'product'>('group');
  const [picking, setPicking] = useState<null | 'group' | 'product'>(null);

  const [makers, setMakers] = useState<ReturnableGroup[]>([]);
  const [items, setItems] = useState<ReturnableProduct[]>([]);
  const [chosenMaker, setChosenMaker] = useState<ReturnableGroup | null>(null);
  const [chosenItem, setChosenItem] = useState<ReturnableProduct | null>(null);
  const [makerUnits, setMakerUnits] = useState<GroupUnit[]>([]);
  const [makerUnitId, setMakerUnitId] = useState<string | null>(null);
  const [qty, setQty] = useState('');
  const [itemShapeId, setItemShapeId] = useState<string | null>(null);

  /*
   * The two lists, read once when the form opens. Both are small — makers are a handful and the
   * ungrouped returnables fewer still — and reading them together means the tab switches with no
   * wait behind it.
   */
  useEffect(() => {
    if (!store) return;
    let alive = true;
    void Promise.all([groupsWithReturnables(store.id), productsWithReturnables(store.id)])
      .then(([g, p]) => {
        if (!alive) return;
        setMakers(g);
        setItems(p);
      })
      .catch(() => {
        /* An empty picker says so on its own; a supplier can still be saved without containers. */
      });
    return () => {
      alive = false;
    };
  }, [store]);

  // The words a maker's containers come back in, so "25 NBL" can say 25 of what.
  useEffect(() => {
    if (!chosenMaker) {
      setMakerUnits([]);
      setMakerUnitId(null);
      return;
    }
    let alive = true;
    void groupReturnUnits(chosenMaker.id)
      .then((u) => {
        if (!alive) return;
        setMakerUnits(u);
        // The one most of the maker's items come back in — `group_return_units` returns them so.
        setMakerUnitId(u[0]?.storeUnitId ?? null);
      })
      .catch(() => alive && setMakerUnits([]));
    return () => {
      alive = false;
    };
  }, [chosenMaker]);
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
  /*
   * One line, at whichever grain the tab is on. The label is built here, from the words the shop
   * just chose, because the list below has to read back as what was entered rather than as ids.
   */
  const addLine = () => {
    const n = Number(qty);
    if (!(n > 0)) return;

    if (tab === 'group' && chosenMaker && makerUnitId) {
      const unit = makerUnits.find((u) => u.storeUnitId === makerUnitId);
      setLines((prev) => [
        ...prev,
        {
          key: String(Date.now()) + '-' + String(prev.length),
          side,
          qty: n,
          label: String(n) + ' ' + (unit?.plural ?? 'containers') + ' \u00b7 ' + chosenMaker.name,
          categoryId: chosenMaker.id,
          storeUnitId: makerUnitId,
        },
      ]);
    } else if (tab === 'product' && chosenItem && itemShapeId) {
      const shape = (byProduct.get(chosenItem.productId) ?? []).find(
        (sh) => sh.productUnitId === itemShapeId,
      );
      setLines((prev) => [
        ...prev,
        {
          key: String(Date.now()) + '-' + String(prev.length),
          side,
          qty: n,
          label:
            String(n) + ' ' + (shape?.plural ?? 'containers') + ' \u00b7 ' + chosenItem.productName,
          productUnitId: itemShapeId,
        },
      ]);
    }

    setQty('');
    setChosenMaker(null);
    setChosenItem(null);
    setItemShapeId(null);
  };

  const onCreated = useObject<(supplier: Supplier) => void>('onSupplierCreated', {
    global: true,
    scope: 'catalog',
  });


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

      /*
       * Each line at the grain it was entered at. A maker line is one row saying "25 NBL crates";
       * it is NOT spread across the maker's products, because the shop does not know that split
       * and inventing one would put crates against beers nobody counted.
       */
      for (const line of lines) {
        const note =
          line.side === 'we_hold'
            ? 'Already in the yard when the account opened'
            : 'Already out with them when the account opened';

        if (line.categoryId && line.storeUnitId) {
          await recordSupplierGroupEmpties({
            storeId: store.id,
            supplierId: id,
            categoryId: line.categoryId,
            storeUnitId: line.storeUnitId,
            qty: line.qty,
            side: line.side,
            direction: 'out',
            note,
          });
        } else if (line.productUnitId) {
          await recordSupplierEmpties({
            storeId: store.id,
            supplierId: id,
            productUnitId: line.productUnitId,
            qty: line.qty,
            side: line.side,
            direction: 'out',
            note,
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

      {/* ── Containers ──────────────────────────────────────────────────────────── */}

      <h3 className={styles.subsection}>Containers between you</h3>
      <p className={styles.sectionNote}>
        Crates and bottles standing in your yard, or yours out on a load. Add a line for each —
        nothing here is required.
      </p>

      {/*
        WHOSE they are. Chosen before the line rather than as two separate lists, because the same
        maker can be on both sides at once and a shop reading this back needs to see which is which
        without counting columns.
      */}
      <div className={styles.sideTabs} role="group" aria-label="Whose containers">
        <button
          type="button"
          className={side === 'we_hold' ? styles.sideOn : styles.side}
          aria-pressed={side === 'we_hold'}
          onClick={() => setSide('we_hold')}
        >
          Theirs, in your yard
        </button>
        <button
          type="button"
          className={side === 'they_hold' ? styles.sideOn : styles.side}
          aria-pressed={side === 'they_hold'}
          onClick={() => setSide('they_hold')}
        >
          Yours, out with them
        </button>
      </div>

      {/*
        BY MAKER OR ITEM BY ITEM, and the two do not overlap: an item that belongs to a maker is
        counted through the maker, so it is not offered here on its own. A yard is settled as
        "25 NBL crates" far more often than per beer, so the maker tab leads.
      */}
      <div className={styles.grainTabs} role="group" aria-label="How you count them">
        <button
          type="button"
          className={tab === 'group' ? styles.grainOn : styles.grain}
          aria-pressed={tab === 'group'}
          onClick={() => setTab('group')}
        >
          By maker
        </button>
        <button
          type="button"
          className={tab === 'product' ? styles.grainOn : styles.grain}
          aria-pressed={tab === 'product'}
          onClick={() => setTab('product')}
        >
          Item by item
        </button>
      </div>

      <div className={styles.composer}>
        <button type="button" className={styles.pick} onClick={() => setPicking(tab)}>
          {tab === 'group'
            ? (chosenMaker?.name ?? 'Choose a maker')
            : (chosenItem?.productName ?? 'Choose an item')}
        </button>

        {tab === 'group' && chosenMaker && makerUnits.length > 1 && (
          /* Only when there genuinely is a choice — one word is not a question. */
          <select
            className={styles.unitSelect}
            value={makerUnitId ?? ''}
            onChange={(e) => setMakerUnitId(e.target.value)}
            aria-label="Counted in"
          >
            {makerUnits.map((u) => (
              <option key={u.storeUnitId} value={u.storeUnitId}>
                {u.plural}
              </option>
            ))}
          </select>
        )}

        {tab === 'product' && chosenItem && (
          <select
            className={styles.unitSelect}
            value={itemShapeId ?? ''}
            onChange={(e) => setItemShapeId(e.target.value)}
            aria-label="Which shape"
          >
            {(byProduct.get(chosenItem.productId) ?? [])
              .filter((sh) => sh.isReturnable)
              .map((sh) => (
                <option key={sh.productUnitId} value={sh.productUnitId}>
                  {sh.plural}
                </option>
              ))}
          </select>
        )}

        <Field
          label="How many"
          numeric
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="0"
        />

        <Button
          fullWidth
          disabled={
            !(Number(qty) > 0) ||
            (tab === 'group' ? !chosenMaker || !makerUnitId : !chosenItem || !itemShapeId)
          }
          onClick={() => addLine()}
        >
          <PlusIcon /> Add this line
        </Button>
      </div>

      {lines.length > 0 && (
        <ul className={styles.lineList}>
          {lines.map((l) => (
            <li key={l.key} className={styles.line}>
              <button
                type="button"
                className={styles.lineRemove}
                onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                aria-label={"Remove " + l.label}
              >
                <CloseIcon />
              </button>
              <span className={styles.lineBody}>
                <span className={styles.lineLabel}>{l.label}</span>
                <span className={styles.lineSide}>
                  {l.side === 'we_hold' ? 'theirs, in your yard' : 'yours, out with them'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* ── The pickers ─────────────────────────────────────────────────────────── */}

      <BottomSheet open={picking === 'group'} onClose={() => setPicking(null)} title="Which maker?">
        {makers.length === 0 ? (
          <p className={styles.pickEmpty}>
            No maker has anything that comes back yet. Put your returnable items into a maker on the
            product, and they can be counted as one pool here.
          </p>
        ) : (
          <ul className={styles.pickList}>
            {makers.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  className={styles.pickRow}
                  onClick={() => {
                    setChosenMaker(g);
                    setChosenItem(null);
                    setPicking(null);
                  }}
                >
                  <span className={styles.pickName}>{g.name}</span>
                  <span className={styles.pickMeta}>
                    {g.products} {g.products === 1 ? 'item' : 'items'} come back
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </BottomSheet>

      <BottomSheet
        open={picking === 'product'}
        onClose={() => setPicking(null)}
        title="Which of your items?"
      >
        {items.length === 0 ? (
          <p className={styles.pickEmpty}>
            Every returnable you have belongs to a maker, so they are all counted under{' '}
            <strong>By maker</strong>. Items appear here only when they are in no maker&rsquo;s pool.
          </p>
        ) : (
          <ul className={styles.pickList}>
            {items.map((it) => (
              <li key={it.productId}>
                <button
                  type="button"
                  className={styles.pickRow}
                  onClick={() => {
                    setChosenItem(it);
                    setChosenMaker(null);
                    const shapes = (byProduct.get(it.productId) ?? []).filter(
                      (sh) => sh.isReturnable,
                    );
                    setItemShapeId(shapes[0]?.productUnitId ?? null);
                    setPicking(null);
                  }}
                >
                  <span className={styles.pickName}>{it.productName}</span>
                  <span className={styles.pickMeta}>
                    {it.shapes} {it.shapes === 1 ? 'shape' : 'shapes'} come back
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </BottomSheet>

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
