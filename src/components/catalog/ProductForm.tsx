'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel, InlineHint } from '@/components/ui/Explain';
import { getSupabase } from '@/lib/supabase/client';
import type { Product } from '@/lib/stacks/catalog-stack';
import styles from './ProductForm.module.css';

/**
 * Add a product, or change one. The BODY of a page — see `product-form-page`.
 *
 * One component for both, because they are the same eight questions and a shop that learns the
 * add form should not have to learn a second, differently-arranged edit form. What changes
 * between the two is which fields the server will accept, not which the person sees.
 *
 * Reachable from three places on purpose — the Stock list, a product's own page, and the picker
 * in the middle of a sale. The last one matters most: a customer asks for something the shop
 * sells but has never entered, and the alternatives are abandoning the receipt or writing the
 * sale down on paper. Both happen, and both end with the ledger being wrong.
 *
 * IT WAS A BOTTOM SHEET AND IS NOW A PAGE. Eight fields, three of them numeric, one conditional
 * on another — on a 390px phone the keyboard covers the half you are typing into, dragging up to
 * reach "Barcode" reads as a dismiss gesture, and there is no back button, so the way out is a
 * gesture you have to already know. A page gets a title, a back arrow, the whole screen, and a
 * URL; it also survives a rotation and a reload, which a sheet's local state does not.
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
}

export function ProductForm({
  onSaved,
  onCancel,
  storeId,
  /** Editing when given; creating when not. */
  product,
  /** Prefills the name when opened from a search that found nothing. */
  initialName = '',
}: {
  onSaved: (result: ProductFormResult) => void;
  onCancel: () => void;
  storeId: string;
  product?: Product | null;
  initialName?: string;
}) {
  const editing = Boolean(product);

  const [name, setName] = useState('');
  const [baseUnit, setBaseUnit] = useState<string>('piece');
  const [packName, setPackName] = useState('');
  const [packQty, setPackQty] = useState('');
  const [price, setPrice] = useState('');
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');

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
    setBaseUnit(product?.baseUnit ?? 'piece');
    setPackName(product?.packName ?? '');
    setPackQty(product?.packQty ?? '');
    setPrice(product?.listPrice ?? '');
    setSku(product?.sku ?? '');
    setBarcode(product?.barcode ?? '');
  }, [product, initialName]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setProblem('Give the item a name.');
      return;
    }

    setSaving(true);
    setProblem(null);
    try {
      const supabase = getSupabase();

      if (editing && product) {
        const { error } = await supabase.rpc('update_product', {
          p_product_id: product.id,
          p_name: trimmed,
          // Empty string CLEARS; null leaves alone. The form always knows its own value, so it
          // always sends one — a blank box means the seller removed the code.
          p_sku: sku.trim(),
          p_barcode: barcode.trim(),
          p_category_id: null,
          p_list_price: price.trim() === '' ? null : Number(price),
        });
        if (error) throw error;
        onSaved({ id: product.id, name: trimmed });
      } else {
        const qty = Number(packQty);
        const { data, error } = await supabase.rpc('create_product', {
          p_store_id: storeId,
          p_name: trimmed,
          p_base_unit: baseUnit,
          p_pack_name: packName.trim() || null,
          p_pack_qty: packName.trim() && Number.isFinite(qty) && qty > 0 ? qty : null,
          p_list_price: price.trim() === '' ? null : Number(price),
          p_price_per_pack: Boolean(packName.trim()),
        });
        if (error) throw error;

        const id = data as string;
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
        onSaved({ id, name: trimmed });
      }
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

      <Field
        label="What is it called?"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Coca-Cola PET 60cl"
        hint="Write it the way you and your customers say it."
        autoFocus
      />

      {!editing && (
        <>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="sm-base-unit">
              How do you count it?
            </label>
            <select
              id="sm-base-unit"
              className={styles.select}
              value={baseUnit}
              onChange={(e) => setBaseUnit(e.target.value)}
            >
              {UNITS.map((u) => (
                <option key={u.code} value={u.code}>
                  {u.label}
                </option>
              ))}
            </select>
            <InlineHint>
              The smallest amount you would ever sell or count. Packs come next.
            </InlineHint>
          </div>

          <Explain label="What is a pack, and do I need one?">
            A pack is how the item arrives and how you usually sell it — a pack of 12 bottles, a
            crate of 12, a carton of 24.
            <br />
            <br />
            Fill this in and you can sell &ldquo;2 packs&rdquo; instead of working out 24 pieces
            every time. Leave it empty for anything you sell one at a time, or by weight.
          </Explain>

          <Field
            label="Pack name"
            optional
            value={packName}
            onChange={(e) => setPackName(e.target.value)}
            placeholder="Pack, Crate, Carton, Bag"
          />

          {packName.trim() !== '' && (
            <Field
              label={`How many ${baseUnit === 'piece' ? 'pieces' : baseUnit} in one ${packName.trim().toLowerCase()}?`}
              numeric
              value={packQty}
              onChange={(e) => setPackQty(e.target.value)}
              placeholder="12"
            />
          )}
        </>
      )}

      <Field
        label={
          packName.trim() || product?.packName
            ? `Price for one ${(packName.trim() || product?.packName || '').toLowerCase()}`
            : 'Price each'
        }
        optional
        numeric
        prefix="₦"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        placeholder="0"
        hint="A starting point. You can always charge something else on the day."
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
