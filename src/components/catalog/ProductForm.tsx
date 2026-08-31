'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { UnitsEditor, unitProblems } from '@/components/catalog/UnitsEditor';
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
}) {
  const nav = useNav();
  const editing = Boolean(product);

  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');

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

  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * Fill from props once the product arrives.
   *
   * As a page this mounts before `useProduct` has resolved an edit target, so the fields start
   * empty and fill in when it does. Keyed on the product itself rather than on a visibility flag,
   * which is what the sheet used — and what made it show the PREVIOUS product's details when
   * opened a second time, so the seller edited the wrong record.
   */
  useEffect(() => {
    setProblem(null);
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

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setProblem('Give the item a name.');
      return;
    }

    const wrong = unitProblems(units);
    if (wrong) {
      setProblem(wrong);
      return;
    }

    setSaving(true);
    setProblem(null);
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
      setProblem(e instanceof Error ? e.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {problem && (
        <InfoPanel tone="danger" title="Not saved">
          {problem}
        </InfoPanel>
      )}

      <h2 className={`${styles.section} ${styles.sectionFirst}`}>What it is</h2>

      <Field
        label="What is it called?"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Coca-Cola PET 60cl"
        hint="Write it the way you and your customers say it."
        autoFocus
      />

      <Field
        label="Your own code"
        optional
        value={sku}
        onChange={(e) => setSku(e.target.value)}
        placeholder="CC-PET-60"
        hint="Anything short you use to find it quickly. Leave empty if you do not use codes."
      />

      <Field
        label="Barcode"
        optional
        value={barcode}
        onChange={(e) => setBarcode(e.target.value)}
        placeholder="5449000000996"
        hint="The number under the bars on the label, if it has one."
      />


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
      <h2 className={styles.section}>How you buy and sell it</h2>
      <p className={styles.sectionNote}>
        The shapes it arrives in and the shapes a customer can buy, with a price on each.
      </p>
      <UnitsEditor
        units={units}
        setUnits={setUnits}
        storeUnits={storeUnits}
        onCreateUnit={(unitName) => onCreateUnit?.(unitName)}
      />

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
