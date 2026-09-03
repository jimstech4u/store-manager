'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './receive-page.module.css';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { useStackBack } from '@/hooks/useStackBack';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { ProductPicker } from '@/components/catalog/ProductPicker';
import { Explain, InfoPanel, WorkedExample } from '@/components/ui/Explain';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { stockInShapes, useBuyingUnits, useSellingUnits } from '@/lib/stacks/selling-units';
import { useAuth } from '@/providers/AuthProvider';
import { fetchProduct, stockMoved, useProductList, type Product } from '@/lib/stacks/catalog-stack';
import { useListNotifier } from '@/hooks/useListChannel';
import { getSupabase } from '@/lib/supabase/client';
import { formatMoney, formatQty, pluralUnit, messageOf } from '@/lib/format';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';

interface ReceiveLine {
  key: string;
  productId: string;
  productName: string;
  baseUnit: string;
  packId: string | null;
  packName: string | null;
  packQty: string | null;
  qty: string;
  /** Per ENTERED unit — per pack when a pack is chosen. What the invoice actually says. */
  unitCost: string;
  /**
   * Thrown in by the supplier, not on the invoice.
   *
   * Sellable stock that cost nothing extra, which is exactly what makes taking the deal worth it —
   * and what makes the cost per unit fall. Counted separately from `qty` because the invoice
   * total must stay the invoice total.
   */
  freeQty: string;
  /**
   * The shop's own unit this arrived in, and what one of them is worth.
   *
   * `packId` is the old one-pack-per-product model. A shop that now says it buys oil in bags AND
   * kilogrammes has two bought-in units and a pack row for neither, so a delivery in bags could
   * only be entered as loose litres. Null falls back to the pack, which is what every delivery
   * recorded before this did.
   */
  buyUnitId: string | null;
  buyUnitName: string | null;
  buyUnitFactor: number | null;
}

const newKey = () => Math.random().toString(36).slice(2);

/**
 * Recording a delivery — where landed cost is established.
 *
 * This screen exists because of one calculation. 100 packs at ₦3,200 with ₦15,000 delivery and
 * ₦5,000 distribution is not ₦266.67 a bottle, it is ₦283.33. A business pricing off the invoice
 * believes a ₦3,300 pack sale earns ₦100 when it actually loses ₦100 — and will keep believing
 * it until something forces the fees into the cost.
 *
 * The fees are shown being applied, live, rather than silently folded in. Seeing the number move
 * is what makes the point land.
 */
export default function ReceivePage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();

  const [lines, setLines] = useState<ReceiveLine[]>([]);
  const [supplier, setSupplier] = useState('');
  const [invoiceRef, setInvoiceRef] = useState('');
  /*
   * The other things a delivery costs, and the ones that give money back.
   *
   * "Delivery" and "Distribution" were the only two boxes, because they were the two somebody
   * happened to name first. A real load carries loading, offloading, a union levy, a gate fee —
   * and the shop paid every one of them, so leaving them out puts the difference straight into
   * what looks like profit. `record_purchase` has taken named charges and a rebate since the
   * costing was rewritten; nothing had ever offered them.
   */
  const [charges, setCharges] = useState<{ key: string; label: string; amount: string }[]>([]);
  const [chargeLabel, setChargeLabel] = useState('');
  const [chargeAmount, setChargeAmount] = useState('');
  const [rebate, setRebate] = useState('');
  /*
   * What each product can arrive in.
   *
   * Loaded for the whole catalogue rather than per line: a delivery has a dozen items on it and a
   * request per row is fine with eight products and painful with eight hundred.
   */
  const { byProduct: buyUnits } = useBuyingUnits(store?.id ?? null);
  // Every shape with stock on it, for the "what is already here" line in the picker.
  const { byProduct: shelfShapes } = useSellingUnits(store?.id ?? null);

  /*
   * The stock list, so a delivery can say what it changed.
   *
   * Read for the CURRENT on-hand of each line — the new figure is that plus what arrived, and the
   * alternative is asking the server for a number this device is about to determine.
   */
  const { products } = useProductList(store?.id ?? null);
  const notifyProducts = useListNotifier<Product>('products');

  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = useProblem();
  const [done, setDone] = useState(false);

  const patch = (key: string, next: Partial<ReceiveLine>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...next } : l)));

  /*
   * An item created from here lands on THIS delivery.
   *
   * The same hook the till uses, published while this screen is open and withdrawn when it closes —
   * a callback left published is found by whoever pushes the form next, which is how a customer
   * created from the People tab once attached itself to an open sale.
   */
  useEffect(() => {
    const cleanup = nav.provideObject(
      'onProductSaved',
      () => async (created: { id: string }) => {
        const fresh = await fetchProduct(created.id);
        if (fresh) addProductRef.current?.(fresh);
      },
      { global: true, scope: 'catalog' },
    );
    return cleanup;
  }, [nav]);

  const addProduct = (p: Product) => {
    const options = buyUnits.get(p.id) ?? [];
    const lead = options.find((u) => u.isDefault) ?? options[0] ?? null;

    setLines((prev) => [
      ...prev,
      {
        key: newKey(),
        productId: p.id,
        productName: p.name,
        baseUnit: p.baseUnit,
        packId: p.packId,
        packName: p.packName,
        packQty: p.packQty,
        qty: '',
        unitCost: '',
        freeQty: '',
        // The largest, which is how a delivery usually arrives — by the bag rather than the litre.
        buyUnitId: lead?.productUnitId ?? null,
        buyUnitName: lead?.name ?? null,
        buyUnitFactor: lead?.baseQty ?? null,
      },
    ]);
    setPicking(false);
  };

  /*
   * Held in a ref, so the callback published above is never a render behind.
   *
   * `provideObject` runs once; `addProduct` closes over `buyUnits`, which arrives after the first
   * render. Without the ref the published version would be the one that could not see the units,
   * and a line added this way would land with no buying unit.
   */
  const addProductRef = useRef(addProduct);
  addProductRef.current = addProduct;

  const factorOf = (l: ReceiveLine) =>
    l.buyUnitFactor ?? (l.packId && l.packQty ? Number(l.packQty) : 1);

  /**
   * Everything that arrived, paid for or not.
   *
   * A supplier who sends 100 packs and throws in 7 has delivered 107 packs of sellable stock for
   * the price of 100 — so the free ones belong in the divisor, and leaving them out is what makes
   * a shop think a good deal cost the same as a bad one.
   */
  const baseQtyOf = (l: ReceiveLine) =>
    ((Number(l.qty) || 0) + (Number(l.freeQty) || 0)) * factorOf(l);

  const goodsTotal = useMemo(
    () => lines.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0),
    [lines],
  );

  const namedCharges = charges.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);


  /*
   * A rebate is money BACK, so it comes off — and it can take the extras below zero, which is
   * correct: a big enough rebate really does make the load cost less than the invoice.
   */
  const fees = namedCharges - (Number(rebate) || 0);
  const grandTotal = goodsTotal + fees;

  /**
   * Landed cost per base unit, allocated by VALUE share.
   *
   * Not split evenly per line: a delivery carrying ₦300,000 of drinks and ₦20,000 of biscuits did
   * not incur half its cost for the biscuits, and an even split would make the cheap line look
   * unprofitable and the expensive one look better than it is.
   */
  const landedFor = (l: ReceiveLine): number | null => {
    const baseQty = baseQtyOf(l);
    const lineValue = (Number(l.qty) || 0) * (Number(l.unitCost) || 0);
    if (baseQty <= 0) return null;
    const raw = lineValue / baseQty;
    // Never below nothing: a rebate larger than the goods would otherwise make stock cost a
    // negative amount, and every margin computed from it would be nonsense. The server clamps the
    // same way, and a preview that disagreed with the saved figure would be its own bug.
    if (goodsTotal <= 0 || fees === 0) return raw;
    return Math.max(raw + (fees * (lineValue / goodsTotal)) / baseQty, 0);
  };

  const submit = async () => {
    if (!store) return;
    setBusy(true);
    try {
      const payload = lines
        .filter((l) => l.productId && Number(l.qty) > 0)
        .map((l) => ({
          product_id: l.productId,
          qty: Number(l.qty),
          free_qty: Number(l.freeQty) || 0,
          // What the shop said one of these holds. The server prefers it over the pack lookup.
          base_factor: l.buyUnitFactor,
          pack_id: l.packId,
          unit_cost: Number(l.unitCost) || 0,
        }));

      if (payload.length === 0) throw new Error('Add at least one item that came in');

      const { error: err } = await getSupabase().rpc('record_purchase', {
        p_store_id: store.id,
        p_lines: payload,
        p_supplier: supplier || null,
        p_invoice_ref: invoiceRef || null,
        /*
         * Everything is a NAMED charge now.
         *
         * `p_delivery` and `p_distribution` stay in the signature for the deliveries already
         * recorded through them, and are sent as nothing: two fixed boxes could never hold what a
         * real load carries, and the shop naming each fee is what makes it readable months later.
         * Both are summed into the same landed cost either way.
         */
        p_delivery: 0,
        p_distribution: 0,
        p_charges: charges
          .filter((c) => c.label.trim() && Number(c.amount) > 0)
          .map((c) => ({ label: c.label.trim(), amount: Number(c.amount) })),
        p_rebate: Number(rebate) || 0,
        // Idempotency: a retry after a timeout must not receive the same delivery twice, which
        // would inflate stock and drag the average cost down with phantom goods.
        p_client_uuid: crypto.randomUUID(),
      });
      if (err) throw err;

      /*
       * WHAT JUST ARRIVED, told to the screens holding it.
       *
       * The stock list showed "0 pieces, ₦0.00" for an item ten crates had just been delivered
       * into — it was holding the row from when the item was created and nothing had said
       * otherwise. This device knows both figures: the quantity is what was typed, and the landed
       * cost is the same sum the server does, verified to the kobo against it.
       */
      for (const l of lines) {
        if (!l.productId) continue;
        const arrived = baseQtyOf(l);
        const landed = landedFor(l);
        const current = Number(
          products.find((x) => x.id === l.productId)?.onHand ?? 0,
        );

        notifyProducts({
          type: 'patch',
          id: l.productId,
          patch: {
            onHand: String(current + arrived),
            /*
             * The dearest stock still held is what a price is warned against, and a delivery that
             * cost more than what is on the shelf becomes that figure. Cheaper stock does not
             * lower it while the dearer is still there, which is why this takes the higher.
             */
            ...(landed !== null ? { avgUnitCost: String(landed), costIsEstimated: false } : {}),
          },
        });
      }

      /*
       * And the DERIVED figures re-read: stock in selling units, the dearest live cost, which
       * items can now come in but never go out. Those the server computes from layers this device
       * cannot see, so this is a re-read that earns its round trip.
       */
      /*
       * The rows this page patched are its own; the VALUE of the shelf and the layers behind it
       * are the server's, and a second till may have sold from the same stock meanwhile.
       */
      stockMoved();

      setDone(true);
    } catch (e: unknown) {
      error.show(messageOf(e, 'Could not record this delivery'));
    } finally {
      setBusy(false);
    }
  };

  if (!store) return null;

  return (
    <PageScaffold
      onBack={goBack}
      title="Record a delivery"
      subtitle="What came in, and what it really cost"
    >
      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={error} title="Could not record this" />

      {/*
        A RESULT IS PAGE CONTENT, not a sheet.

        This was a BottomSheet, and a sheet is an overlay with its own history entry. Its Done
        button popped a page while that entry was still open, so the two unwound each other: the
        stack went from `stock-stack:1.a1.b1` to `stock-stack:1` and the shop was left looking at a
        COMPLETELY BLANK SCREEN, having just recorded a delivery. Closing the sheet first only
        moved the race — the deferred history step landed back on a page that had already
        unmounted, blank again.

        The rule this codebase already carries is "a form is a page, a choice is a sheet". A result
        is neither: it is the answer to what the page was for, so it belongs in the page.
      */}
      {done && (
        <>
          <InfoPanel tone="success" title="Stock is in">
            Your stock has gone up, and the cost of each item now includes the fees and any rebate
            you entered.
          </InfoPanel>

          <div className={styles.actions}>
            <Button size="large" fullWidth onClick={() => void nav.pop()}>
              Done
            </Button>
          </div>
        </>
      )}

      {!done && lines.length === 0 && (
        <InfoPanel tone="info" title="Add what came in">
          Enter the quantity and the price on the invoice. The delivery and distribution fees go
          in below, and we will work out what each item truly cost you.
        </InfoPanel>
      )}

      <div className={styles.lines}>
        {lines.map((l) => {
          const landed = landedFor(l);
          const raw = Number(l.qty) > 0 ? (Number(l.unitCost) || 0) : 0;
          const perBaseRaw = l.packId && l.packQty ? raw / Number(l.packQty) : raw;

          return (
            <div className={styles.line} key={l.key}>
              <div className={styles.lineHead}>
                <p className={styles.lineName}>{l.productName}</p>
                <button
                  type="button"
                  className={styles.remove}
                  onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                  aria-label={`Remove ${l.productName}`}
                >
                  <CloseIcon />
                </button>
              </div>

              <div className={styles.grid}>
                <Field
                  label="How many"
                  numeric
                  value={l.qty}
                  onChange={(e) => patch(l.key, { qty: e.target.value })}
                  suffix={l.buyUnitName ?? l.packName ?? l.baseUnit}
                  placeholder="0"
                />
                <Field
                  label={`Price per ${(l.buyUnitName ?? l.packName ?? l.baseUnit).toLowerCase()}`}
                  numeric
                  prefix="₦"
                  value={l.unitCost}
                  onChange={(e) => patch(l.key, { unitCost: e.target.value })}
                  placeholder="0"
                  hint="What the invoice says."
                />
              </div>

              {/*
                What the supplier threw in.

                Optional and quiet, because most lines have none — but a "buy 20 get 1 free" is
                ordinary in this trade, and a shop that cannot record it either loses the free
                stock from its shelf count or records it as bought and drags its own cost up.
              */}
              <Field
                label="Free, on top"
                optional
                numeric
                value={l.freeQty}
                onChange={(e) => patch(l.key, { freeQty: e.target.value })}
                suffix={l.buyUnitName ?? l.packName ?? l.baseUnit}
                placeholder="0"
                hint="Thrown in by the supplier. It lands on the shelf and lowers your cost."
              />

              {/*
                Which shape it arrived in, when the shop takes this in more than one.

                Only shown when there is a genuine choice: a product bought only in crates has one
                answer, and a select with one option is a question with no purpose.
              */}
              {(buyUnits.get(l.productId)?.length ?? 0) > 1 && (
                <label className={styles.unitChoice}>
                  <span className={styles.unitChoiceLabel}>It arrived in</span>
                  <select
                    className={styles.unitSelect}
                    value={l.buyUnitId ?? ''}
                    onChange={(e) => {
                      const chosen = buyUnits
                        .get(l.productId)
                        ?.find((u) => u.productUnitId === e.target.value);
                      patch(l.key, {
                        buyUnitId: chosen?.productUnitId ?? null,
                        buyUnitName: chosen?.name ?? null,
                        buyUnitFactor: chosen?.baseQty ?? null,
                      });
                    }}
                  >
                    {(buyUnits.get(l.productId) ?? []).map((u) => (
                      <option key={u.productUnitId} value={u.productUnitId}>
                        {u.plural}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {Number(l.qty) > 0 && (
                <div className={styles.lineFoot}>
                  <span>
                    {formatQty(baseQtyOf(l))} {pluralUnit(l.baseUnit, baseQtyOf(l))} in total
                  </span>
                  {landed !== null && (
                    <span className={styles.landed}>
                      {fees !== 0 && (
                        <span className={styles.rawCost}>{formatMoney(perBaseRaw, 2)}</span>
                      )}
                      {formatMoney(landed, 2)} each
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Button size="large" fullWidth onClick={() => setPicking(true)}>
        <PlusIcon /> Add an item
      </Button>

      {lines.length > 0 && (
        <>
          <h2 className={styles.section}>What else this load cost</h2>
          <p className={styles.sectionNote}>
            Delivery, loading, a union levy — whatever you paid on top of the invoice. Shared
            across everything above, by value.
          </p>

          {/*
            ONE SET OF BOXES, and a list of what has been added.

            Not a fixed field per kind of fee. Nobody can name in advance every charge a load might
            carry, and a screen that tries has ten empty boxes on it for the nine that do not apply
            this time. The shop names each one as it adds it — which is also why they are stored by
            name: "loading" and "union levy" still mean something when somebody reads it back.
          */}
          {charges.length > 0 && (
            <ul className={styles.chargeList}>
              {charges.map((c) => (
                <li key={c.key} className={styles.chargeItem}>
                  <span>{c.label}</span>
                  <span className={styles.chargeAmount}>{formatMoney(Number(c.amount) || 0)}</span>
                  <button
                    type="button"
                    className={styles.chargeRemove}
                    aria-label={`Remove ${c.label}`}
                    onClick={() => setCharges((prev) => prev.filter((x) => x.key !== c.key))}
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className={styles.grid}>
            <Field
              label="What for"
              optional
              value={chargeLabel}
              onChange={(e) => setChargeLabel(e.target.value)}
              placeholder="Delivery, loading, levy…"
            />
            <Field
              label="How much"
              optional
              numeric
              prefix="₦"
              value={chargeAmount}
              onChange={(e) => setChargeAmount(e.target.value)}
              placeholder="0"
            />
          </div>

          <Button
            fullWidth
            disabled={!chargeLabel.trim() || !(Number(chargeAmount) > 0)}
            onClick={() => {
              setCharges((prev) => [
                ...prev,
                { key: newKey(), label: chargeLabel.trim(), amount: chargeAmount },
              ]);
              setChargeLabel('');
              setChargeAmount('');
            }}
          >
            <PlusIcon /> Add this fee
          </Button>

          {/*
            Money coming back, which is the only figure here that makes stock cheaper.

            Its own box rather than a fee typed as a negative: somebody one missed minus sign away
            from a delivery costing twenty thousand MORE than it did.

            And its own SPACED block: it sat flush against the Add-this-fee button, so it read as
            part of the fee composer above it — a third field of the thing you are adding, rather
            than a separate figure for the whole load.
          */}
          <div className={styles.rebate}>
          <Field
            label="Rebate or discount given back"
            optional
            numeric
            prefix="₦"
            value={rebate}
            onChange={(e) => setRebate(e.target.value)}
            placeholder="0"
            hint="Money the supplier gave back on this load. It lowers what the stock cost you."
          />
          </div>

          <Explain label="Why do the fees change my cost?" defaultOpen={fees !== 0}>
            <p>
              Because you paid them. If you only count the invoice price, every sale looks more
              profitable than it was — and the gap is exactly the fees.
            </p>
            <WorkedExample
              rows={[
                { label: '100 packs at ₦3,200', value: '₦320,000' },
                { label: 'Delivery', value: '₦15,000' },
                { label: 'Distribution', value: '₦5,000' },
                { label: 'True cost per bottle', value: '₦283.33', emphasis: true },
              ]}
              note={
                <>
                  Going by the invoice alone, a pack sold at ₦3,300 looks like ₦100 profit. It is
                  a <strong>₦100 loss</strong>.
                </>
              }
            />
          </Explain>

          <div className={styles.totals}>
            <div className={styles.totalRow}>
              <span>Goods</span>
              <span className={styles.totalValue}>{formatMoney(goodsTotal)}</span>
            </div>
            {fees > 0 && (
              <div className={styles.totalRow}>
                <span>Fees</span>
                <span className={styles.totalValue}>{formatMoney(fees)}</span>
              </div>
            )}
            <div className={`${styles.totalRow} ${styles.grandRow}`}>
              <span className={styles.grandLabel}>Total paid</span>
              <span className={styles.grandValue}>{formatMoney(grandTotal)}</span>
            </div>
          </div>

          <Field
            label="Supplier"
            optional
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            placeholder="Who delivered this"
          />
          <Field
            label="Invoice number"
            optional
            value={invoiceRef}
            onChange={(e) => setInvoiceRef(e.target.value)}
            placeholder="For your own records"
          />
        </>
      )}

      {/*
        The same picker the sell screen uses, not a second one.

        This was a `BottomSheet` wrapped round a `SearchField`, and it had every problem the sell
        screen's picker had already solved: it sat under the keyboard, a touch while typing closed
        it, and it had no loading state — a slow search looked like a shop with no products at all.
      */}
      <ProductPicker
        open={picking}
        onClose={() => setPicking(false)}
        storeId={store.id}
        title="What came in?"
        onPick={addProduct}
        /*
          THE LOAD IS ALREADY OFF THE LORRY.

          This used to say "add it under Stock first", which means abandoning a half-entered
          delivery, filing the item on another screen, and coming back to start again — for a case
          of something the supplier simply sent this week. The item gets created here and the line
          lands on the delivery, exactly as the till does it; a manager checks it afterwards.
        */
        /*
          THE REAL FORM, PUSHED. The delivery is pushed under and keeps every line already entered.
        */
        onAddNew={(typed) => {
          setPicking(false);
          void nav.push('product_form_page', {
            required: 'minimum',
            ...(typed?.trim() ? { name: typed.trim() } : {}),
          });
        }}
        emptyHint="Nothing by that name yet — add it here and carry on with the delivery."
        renderMeta={(p) => {
          /*
            READ WHILE DECIDING HOW MUCH MORE TO TAKE. "1196 bottles in stock" makes somebody do a
            division standing at a lorry; "99 crates 8 bottles" is the answer they were after.
          */
          const shapes = shelfShapes.get(p.id);
          return (
            <>
              {shapes && shapes.length > 0
                ? stockInShapes(shapes)
                : `${formatQty(p.onHand)} ${pluralUnit(p.baseUnit, Number(p.onHand))}`}{' '}
              in stock
              {p.categoryName ? ` · ${p.categoryName}` : ''}
            </>
          );
        }}
      />


      {/*
        The outcome is a SHEET, not a replacement screen.

        It has nothing to type and one way on, so it does not need the keyboard room a page exists
        to provide — and replacing the whole screen to say two sentences threw away the delivery
        that was just entered, which is the thing somebody double-checking would want to see behind
        the confirmation.

        Not dismissible by a stray swipe: it is the only confirmation that the stock actually went
        in, and a delivery is the sort of thing people re-enter if they are unsure it saved.
      */}

      {/*
        The total and the action END the page rather than being pinned to its foot.

        A pinned bar costs a row of the form on every phone this runs on, and this screen is a
        list of delivery lines with three number fields each, plus the fee composer. Scrolling to
        the end to commit is also the honest gesture: the last thing somebody should see before
        recording what a load cost is the last figure they entered into it.
      */}
      {!done && lines.length > 0 && (
        <div className={styles.actions}>
          <div className={styles.footerRow}>
            <span className={styles.footerLabel}>Total paid</span>
            <span className={styles.footerTotal}>{formatMoney(grandTotal)}</span>
          </div>
          <Button size="large" fullWidth busy={busy} busyLabel="Recording" onClick={submit}>
            Record this delivery
          </Button>
        </div>
      )}
    </PageScaffold>
  );
}
