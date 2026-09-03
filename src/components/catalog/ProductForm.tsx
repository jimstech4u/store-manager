'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { CameraIcon } from '@/components/ui/Icon';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { UnitsEditor, unitProblems } from '@/components/catalog/UnitsEditor';
import { BarcodeScanner } from '@/components/catalog/BarcodeScanner';
import { DiscountsEditor, type Discount } from '@/components/catalog/DiscountsEditor';
import { useNav } from '@academix-admin/navigation-stack';
import {
  fetchDiscounts,
  saveDiscounts,
  saveProductUnits,
  useProductUnits,
  useStoreUnits,
  type ProductUnit,
  type StoreUnit,
} from '@/lib/stacks/product-units';
import { getSupabase } from '@/lib/supabase/client';
import type { Product } from '@/lib/stacks/catalog-stack';
import styles from './ProductForm.module.css';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { messageOf } from '@/lib/format';

/**
 * Add a product, or change one. The BODY of a page — see `product-form-page`.
 *
 * ONE FORM, ONE PRODUCT. It used to ask "how do you count it?" and "what is a pack?", which is the
 * one-pack-per-product model: a base unit, one pack, one price. Real trade does not fit it. Cooking
 * oil arrives in bags and in kilogrammes and leaves by the litre; beer arrives in crates and leaves
 * as crates, half crates and single bottles. A shop with any of that had to either lie to the form
 * or keep the real answer in its head.
 *
 * So the form asks what the item IS — its name and the codes you find it by — and then the two
 * questions that actually matter: what it is bought in, what it is sold in, and what a customer
 * pays for buying more of it.
 *
 * A NEW PRODUCT IS CREATED BEFORE ITS UNITS ARE SAVED, because units and prices hang off an id
 * that does not exist until then. If the units fail to save, the item still exists — unconfigured,
 * and visibly so: the stock screen names anything that can arrive but never leave.
 *
 * Reachable from three places on purpose — the Stock list, a product's own page, and the picker in
 * the middle of a sale. The last one matters most: a customer asks for something the shop sells but
 * has never entered, and the alternatives are abandoning the receipt or writing the sale down on
 * paper. Both happen, and both end with the ledger being wrong.
 */

/*
 * The global units a product row can be measured in.
 *
 * `products.base_unit` is a foreign key to a fixed list and is now only a fallback label — the
 * shop's own units carry the meaning. It is no longer asked for: it is worked out from the
 * smallest thing the shop said it sells, and falls back to pieces, which is what most goods are.
 */
const UNITS = [
  { code: 'piece', label: 'Pieces — bottles, cans, wraps, items' },
  { code: 'kg', label: 'Kilograms — rice, garri, cement' },
  { code: 'g', label: 'Grams' },
  { code: 'litre', label: 'Litres' },
  { code: 'cl', label: 'Centilitres' },
  { code: 'metre', label: 'Metres — cloth, cable' },
  { code: 'yard', label: 'Yards — cloth' },
] as const;

export interface ProductFormResult {
  id: string;
  name: string;
  /**
   * The row as it now stands, for a list to patch itself with.
   *
   * It used to hand back only an id and a name, on the reasoning that a new product's cost, stock
   * and pack are computed elsewhere and fabricating them would put wrong numbers on screen. That
   * is true of a product that has TRADED. A product created ten seconds ago has nothing on the
   * shelf and nothing spent on it, and saying so is not a guess — it is the only correct answer.
   * So the list takes this row and shows it, with no round trip to be told what it already knows.
   */
  row: Product;
  /** New here, as opposed to an edit — the list inserts rather than patches. */
  created: boolean;
}

export function ProductForm({
  onSaved,
  onCancel,
  storeId,
  /** Editing when given; creating when not. */
  product,
  /** Prefills the name when opened from a search that found nothing. */
  initialName = '',
  onCreateUnit,
  minimum = false,
}: {
  onSaved: (result: ProductFormResult) => void;
  onCancel: () => void;
  storeId: string;
  product?: Product | null;
  initialName?: string;
  /**
   * Hands over to whoever can push the page that invents a new unit.
   *
   * The form does not push it itself: this component is rendered from three stacks, and a
   * component reaching for a route by name breaks the moment it is reused where that route does
   * not exist — the same reason the customer picker asks its caller.
   */
  onCreateUnit?: (name: string) => void;
  /**
   * ASK ONLY WHAT THE SALE NEEDS, and ask it properly.
   *
   * Set when this form is pushed from a counter with a customer waiting. It does not hide
   * anything — every field is still here, below — it changes which ones are REQUIRED and which
   * sections start folded.
   *
   * The three it adds are required in this mode and not in the other, because at a counter they
   * are knowable and later they are not: what is on the shelf right now, whether the container
   * comes back, and how many are already out. A shop that answers them a day later is guessing.
   */
  minimum?: boolean;
}) {
  const nav = useNav();
  const editing = Boolean(product);

  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');
  // Folded at a counter, open everywhere else. See the disclosure below.
  const [showCodes, setShowCodes] = useState(false);

  /*
   * The opening facts, and why they are REQUIRED WITH ZERO ALLOWED.
   *
   * "None on the shelf" and "nobody looked" are different facts, and only one of them means the
   * next person can trust the figure. Leaving these optional makes every new item silently claim
   * nothing is out and nothing is owed — which is right most of the time and catastrophic the rest,
   * because nobody ever goes back to check a blank they did not know they left.
   *
   * So the form insists on an answer and accepts 0 as one.
   */
  const [openingCount, setOpeningCount] = useState('');
  const [returnable, setReturnable] = useState(false);
  const [poolName, setPoolName] = useState('');
  const [poolKind, setPoolKind] = useState<'content' | 'container'>('content');
  const [poolPerUnit, setPoolPerUnit] = useState('1');
  const [poolDeposit, setPoolDeposit] = useState('');
  const [emptiesOut, setEmptiesOut] = useState('');
  const [pools, setPools] = useState<{ id: string; name: string; kind: string; deposit: string }[]>([]);

  /*
   * What it is bought and sold in, and the cheaper prices for buying more.
   *
   * Held here and saved with the name, so a shop answers the whole question in one place. For an
   * item being edited these arrive from the server; for a new one they start empty and the form
   * refuses to save until at least one thing is sellable.
   */
  const { units: existingUnits } = useProductUnits(product?.id ?? null);
  const { units: storeUnits, add: addStoreUnit } = useStoreUnits(storeId);
  const [units, setUnits] = useState<ProductUnit[]>([]);
  const [discounts, setDiscounts] = useState<Discount[]>([]);

  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const problem = useProblem();

  /*
   * Fill from props once the product arrives.
   *
   * As a page this mounts before `useProduct` has resolved an edit target, so the fields start
   * empty and fill in when it does. Keyed on the product itself rather than on a visibility flag,
   * which is what the sheet used — and what made it show the PREVIOUS product's details when
   * opened a second time, so the seller edited the wrong record.
   */
  useEffect(() => {
    setName(product?.name ?? initialName);
    setSku(product?.sku ?? '');
    setBarcode(product?.barcode ?? '');
  }, [product, initialName]);

  /*
   * The units this item already has, once they arrive.
   *
   * Copied into local state rather than edited in place: this is a form, and nothing reaches the
   * shop until Save. Guarded on length so a re-render cannot overwrite edits in progress with the
   * server's copy — the same shape as filling the name above.
   */
  /*
   * A unit invented on the pushed page, put straight into the picker.
   *
   * This page never unmounts while the unit form sits on top of it, so nothing would otherwise
   * tell the picker the shop has a new word — and it was missing until somebody reloaded. Added
   * to the cache rather than refetched: this device made the change and already knows the answer.
   */
  const onUnitCreatedRef = useRef<(unit: StoreUnit) => void>(() => {});
  onUnitCreatedRef.current = (unit) => addStoreUnit(unit);

  useEffect(() => {
    const cleanup = nav.provideObject(
      'onUnitCreated',
      () => (unit: StoreUnit) => onUnitCreatedRef.current(unit),
      { global: true, scope: 'catalog' },
    );
    return cleanup;
  }, [nav]);

  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || existingUnits.length === 0) return;
    seeded.current = true;
    setUnits(existingUnits);
  }, [existingUnits]);

  useEffect(() => {
    if (!product?.id) return;
    let live = true;
    void fetchDiscounts(product.id).then((rows) => {
      if (live) setDiscounts(rows);
    });
    return () => {
      live = false;
    };
  }, [product?.id]);

  /*
   * The unit a product ROW is measured in.
   *
   * `products.base_unit` points at a fixed global list and is only a fallback label now — the
   * shop's own units carry the meaning. Rather than asking a question whose answer is already
   * implied, it is read off the smallest thing the shop said it sells, matched by name, and falls
   * back to pieces. A shop selling litres gets litres; a shop selling crates of drinks gets pieces,
   * which is what a crate is made of.
   */
  const impliedBaseUnit = (): string => {
    const sold = units.filter((u) => u.isSold);
    if (sold.length === 0) return 'piece';
    const smallest = sold.reduce((a, b) => (b.baseQty < a.baseQty ? b : a));
    const match = UNITS.find((g) => g.code === smallest.name.toLowerCase());
    return match?.code ?? 'piece';
  };

  /*
   * The pools this shop already has.
   *
   * Offered rather than typed, because "NBL crate" and "NBL Crate" are one pool to a shop and two
   * rows to a database. The seller can still name a new one — `set_product_returnable` matches
   * case-insensitively and creates it only when nothing matches.
   */
  useEffect(() => {
    if (editing) return;
    let cancelled = false;
    void getSupabase()
      .rpc('store_empties_categories', { p_store_id: storeId })
      .then(({ data }) => {
        if (!cancelled) setPools((data ?? []) as typeof pools);
      });
    return () => {
      cancelled = true;
    };
  }, [storeId, editing]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      problem.show('Give the item a name.');
      return;
    }

    /*
     * REQUIRED, AND ZERO IS AN ANSWER.
     *
     * Blank is refused; "0" is accepted and recorded. The difference is the whole point — a shop
     * that has run out of something is a fact worth writing down, and a shop that never looked is
     * a figure nobody should trust. Only in `minimum` mode, because that is the moment somebody is
     * standing in front of the shelf.
     */
    if (minimum && openingCount.trim() === '') {
      problem.show('How many are on the shelf right now? Put 0 if there are none.');
      return;
    }
    if (minimum && returnable && !poolName.trim()) {
      problem.show('What comes back — a crate, a bottle? Name it, or turn off "comes back".');
      return;
    }
    if (minimum && returnable && emptiesOut.trim() === '') {
      problem.show('How many are already out with customers? Put 0 if none are.');
      return;
    }

    const wrong = unitProblems(units);
    if (wrong) {
      problem.show(wrong);
      return;
    }

    setSaving(true);
    try {
      const supabase = getSupabase();
      let id = product?.id ?? '';

      if (editing && product) {
        const { error } = await supabase.rpc('update_product', {
          p_product_id: product.id,
          p_name: trimmed,
          // Empty string CLEARS; null leaves alone. The form always knows its own value, so it
          // always sends one — a blank box means the seller removed the code.
          p_sku: sku.trim(),
          p_barcode: barcode.trim(),
          p_category_id: null,
          /*
           * No list price any more.
           *
           * Price belongs to a UNIT — a crate and a bottle are not the same money — and asking for
           * one figure per product is what produced a receipt reading "1 piece, ₦4,500" for
           * something sold by the pack. Null leaves whatever is there alone.
           */
          p_list_price: null,
        });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.rpc('create_product', {
          p_store_id: storeId,
          p_name: trimmed,
          p_base_unit: impliedBaseUnit(),
          // The one-pack model, no longer asked for and no longer sent.
          p_pack_name: null,
          p_pack_qty: null,
          p_list_price: null,
          p_price_per_pack: false,
        });
        if (error) throw error;
        id = data as string;

        // Codes are a second call: create_product predates them and widening it would mean a
        // second overload of a function half the app already calls.
        if (sku.trim() || barcode.trim()) {
          await supabase.rpc('update_product', {
            p_product_id: id,
            p_name: null,
            p_sku: sku.trim(),
            p_barcode: barcode.trim(),
            p_category_id: null,
            p_list_price: null,
          });
        }
      }

      /*
       * Units before discounts, because a discount points at a unit.
       *
       * Saving the units also rebuilds what the till reads, so the sale units a band refers to
       * exist by the time the bands are written.
       */
      await saveProductUnits(id, units);
      await saveDiscounts(id, discounts);

      /*
       * The opening facts, AFTER the units — a count is in base units and the units define them.
       *
       * Ordered rather than parallel, and deliberately: if the returnable link fails, the shop
       * still has an item it can sell, and the failure says so. The reverse — a returnable pool
       * pointing at a product whose units never saved — is a row nobody can read.
       */
      if (!editing && openingCount.trim() !== '') {
        const { error } = await supabase.rpc('open_stock_by_count', {
          p_store_id: storeId,
          p_product_id: id,
          p_qty: Number(openingCount) || 0,
          p_unit_cost: null,
          p_note: 'Counted when the item was added',
        });
        if (error) throw error;
      }

      if (!editing && returnable && poolName.trim()) {
        const { error } = await supabase.rpc('set_product_returnable', {
          p_store_id: storeId,
          p_product_id: id,
          p_category_name: poolName.trim(),
          p_kind: poolKind,
          p_qty_per_base_unit: Number(poolPerUnit) || 1,
          p_deposit: Number(poolDeposit) || 0,
        });
        if (error) throw error;
      }

      /*
       * The row, built from what this device just did.
       *
       * Nothing here is invented: a brand-new item has nothing on the shelf and nothing spent on
       * it, and an edited one keeps the figures it already had while taking the name and codes
       * that were just typed.
       */
      const row: Product = {
        ...(product ?? {
          baseUnit: impliedBaseUnit(),
          categoryId: null,
          categoryName: null,
          avgUnitCost: '0',
          costIsEstimated: false,
          onHand: '0',
          packId: null,
          packName: null,
          packQty: null,
          listPrice: null,
        }),
        id,
        name: trimmed,
        sku: sku.trim() || null,
        barcode: barcode.trim() || null,
      };

      onSaved({ id, name: trimmed, row, created: !editing });
    } catch (e) {
      problem.show(messageOf(e, 'That could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={problem} title="Not saved" />

      {/*
        No heading over the first question.

        "What it is" sat directly above "What is it called?", under a page already titled "Add an
        item you sell" — the same thing said three times before a shop has typed anything. The rule
        and the space below still separate this from the next section, which is what the heading
        was really for.
      */}
      <Field
        label="What is it called?"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Coca-Cola PET 60cl"
        hint="Write it the way you and your customers say it."
        autoFocus
      />

      {/*
        THE CODES FOLD AWAY WHEN THERE IS SOMEBODY WAITING.

        Nothing is removed — every field is one tap down — but a seller adding something mid-sale
        met "Your own code" and "Barcode" before anything the sale needs. `minimum` was changing
        which fields are required and leaving the order alone, which is half a job: the fastest way
        to make a form feel long is to put its optional half first.
      */}
      {minimum ? (
        <>
          <button
            type="button"
            className={styles.disclosure}
            onClick={() => setShowCodes((v) => !v)}
            aria-expanded={showCodes}
          >
            {showCodes ? 'Hide codes and barcode' : 'Codes and barcode'}
            <span aria-hidden="true">{showCodes ? '\u2212' : '+'}</span>
          </button>
          {showCodes && (
            <>
      <Field
        label="Your own code"
        optional
        value={sku}
        onChange={(e) => setSku(e.target.value)}
        placeholder="CC-PET-60"
        hint="Anything short you use to find it quickly. Leave empty if you do not use codes."
      />

      {/*
        Thirteen digits off a curved label, at a counter.

        Typed, that is the kind of task people abandon halfway — and a wrong barcode is worse than
        none, because it will match the wrong thing later. The phone already has a scanner.
      */}
      <Field
        label="Barcode"
        optional
        value={barcode}
        onChange={(e) => setBarcode(e.target.value)}
        placeholder="5449000000996"
        hint="The number under the bars on the label, if it has one."
      />

      <Button variant="secondary" fullWidth onClick={() => setScanning(true)}>
        <CameraIcon /> Scan it with the camera
      </Button>

      <BarcodeScanner
        open={scanning}
        onClose={() => setScanning(false)}
        onRead={(code) => {
          setBarcode(code);
          setScanning(false);
        }}
      />
            </>
          )}
        </>
      ) : (
        <>
      <Field
        label="Your own code"
        optional
        value={sku}
        onChange={(e) => setSku(e.target.value)}
        placeholder="CC-PET-60"
        hint="Anything short you use to find it quickly. Leave empty if you do not use codes."
      />

      {/*
        Thirteen digits off a curved label, at a counter.

        Typed, that is the kind of task people abandon halfway — and a wrong barcode is worse than
        none, because it will match the wrong thing later. The phone already has a scanner.
      */}
      <Field
        label="Barcode"
        optional
        value={barcode}
        onChange={(e) => setBarcode(e.target.value)}
        placeholder="5449000000996"
        hint="The number under the bars on the label, if it has one."
      />

      <Button variant="secondary" fullWidth onClick={() => setScanning(true)}>
        <CameraIcon /> Scan it with the camera
      </Button>

      <BarcodeScanner
        open={scanning}
        onClose={() => setScanning(false)}
        onRead={(code) => {
          setBarcode(code);
          setScanning(false);
        }}
      />
        </>
      )}

      {/*
        What it is bought in and sold in.

        This replaced "How do you count it?" and "What is a pack?" — the one-pack-per-product
        model, which real trade does not fit: oil arrives in bags and in kilogrammes and leaves by
        the litre, beer arrives in crates and leaves as crates, half crates and single bottles. A
        shop with any of that had to either lie to the form or keep the real answer in its head.

        The single "Price each" went with it. Price belongs to a UNIT — a crate and a bottle are
        not the same money — and one figure per product is what produced a receipt reading
        "1 piece, ₦4,500" for something sold by the pack.
      */}
      <h2 className={styles.section}>The shapes it comes in</h2>
      <p className={styles.sectionNote}>
        A crate, and the bottles inside it. Say what each holds once, then tick what it is for —
        buying, selling, counting, deposits. Everything else on this item reads these.
      </p>
      <UnitsEditor
        units={units}
        setUnits={setUnits}
        storeUnits={storeUnits}
        onCreateUnit={(unitName) => onCreateUnit?.(unitName)}
      />

      {/*
        WHAT IS TRUE RIGHT NOW, asked while somebody is standing in front of the shelf.

        Only when creating. Editing an item a week later and being asked "how many are on the
        shelf?" invites a guess, and a guess written into stock is worse than no figure — it looks
        like a count.

        Required in `minimum` mode with ZERO ACCEPTED. Blank and nought are different facts and the
        form refuses to conflate them: a shop that has run out is worth recording, a shop that never
        looked is a number nobody should trust.
      */}
      {!editing && (
        <>
          <h2 className={styles.section}>What you have now</h2>
          <p className={styles.sectionNote}>
            Counted on the shelf, not worked out from deliveries. Most shops starting here have
            stock and no delivery history, and an invented delivery invents a cost.
          </p>
          <Field
            label="On the shelf right now"
            numeric
            required={minimum}
            value={openingCount}
            onChange={(e) => setOpeningCount(e.target.value)}
            placeholder="0"
            hint={
              minimum
                ? 'Put 0 if there are none. "None" and "did not look" are different answers.'
                : 'Leave it blank if you would rather count later.'
            }
          />

          <h2 className={styles.section}>Does the container come back?</h2>
          <p className={styles.sectionNote}>
            Crates and bottles a customer returns. Say so now and every sale tracks them for you.
          </p>

          <label className={styles.toggleRow}>
            <input
              type="checkbox"
              checked={returnable}
              onChange={(e) => setReturnable(e.target.checked)}
            />
            <span>Yes — something comes back with this</span>
          </label>

          {returnable && (
            <>
              <Field
                label="What comes back"
                required={minimum}
                value={poolName}
                onChange={(e) => setPoolName(e.target.value)}
                placeholder="NBL crate"
                list="empties-pools"
                hint={
                  pools.length > 0
                    ? `Pick one you already use, or name a new one. You have: ${pools
                        .map((p) => p.name)
                        .join(', ')}.`
                    : 'Name the pool. Products that share a pool settle each other — a Star bottle pays back a Gulder bottle.'
                }
              />
              <datalist id="empties-pools">
                {pools.map((p) => (
                  <option key={p.id} value={p.name} />
                ))}
              </datalist>

              <div className={styles.toggleRow}>
                <label>
                  <input
                    type="radio"
                    checked={poolKind === 'content'}
                    onChange={() => setPoolKind('content')}
                  />
                  <span>A bottle — counted from how much is sold</span>
                </label>
              </div>
              <div className={styles.toggleRow}>
                <label>
                  <input
                    type="radio"
                    checked={poolKind === 'container'}
                    onChange={() => setPoolKind('container')}
                  />
                  {/*
                    A container's count cannot be derived and is declared at the till: six loose
                    bottles may or may not go out in a crate, and only the person handing them over
                    knows which.
                  */}
                  <span>A crate — counted when one actually leaves</span>
                </label>
              </div>

              {poolKind === 'content' && (
                <Field
                  label="How many come back per unit sold"
                  numeric
                  value={poolPerUnit}
                  onChange={(e) => setPoolPerUnit(e.target.value)}
                  placeholder="1"
                  hint="One bottle per bottle sold, usually."
                />
              )}

              <Field
                label="What you usually hold as deposit, each"
                optional
                numeric
                prefix="₦"
                value={poolDeposit}
                onChange={(e) => setPoolDeposit(e.target.value)}
                placeholder="0"
                hint="A suggestion the till offers you. You still decide the figure on the day."
              />

              <Field
                label="Already out with customers"
                numeric
                required={minimum}
                value={emptiesOut}
                onChange={(e) => setEmptiesOut(e.target.value)}
                placeholder="0"
                hint="From before you started here. Put 0 if none are out."
              />
            </>
          )}
        </>
      )}

      <h2 className={styles.section}>Cheaper for buying more</h2>
      <p className={styles.sectionNote}>
        A price that applies once a customer takes enough of them. Optional.
      </p>
      <DiscountsEditor
        discounts={discounts}
        setDiscounts={setDiscounts}
        soldUnits={units.filter((u) => u.isSold)}
      />

      {!editing && (
        <InfoPanel tone="info" title="Stock comes later">
          Adding an item does not put any on the shelf. Record a delivery under{' '}
          <strong>Stock</strong> when it arrives, and the cost is worked out from what you actually
          paid.
        </InfoPanel>
      )}

      {/*
        The actions sit at the end of the page, not pinned to its foot.

        A pinned bar costs a row of the form on every phone this runs on, and this form is already
        eight fields long. Scrolling to the bottom to commit is also the honest gesture: you have
        just been asked eight questions, and the last thing you should see before saving is your
        answer to the eighth.
      */}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button busy={saving} onClick={() => void save()}>
          {editing ? 'Save changes' : 'Add it'}
        </Button>
      </div>
    </>
  );
}
