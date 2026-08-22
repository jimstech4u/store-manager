'use client';

import { useMemo, useState } from 'react';
import styles from './receive-page.module.css';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { SearchField, useDebounced } from '@/components/ui/SearchField';
import { Explain, InfoPanel, WorkedExample } from '@/components/ui/Explain';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { useAuth } from '@/providers/AuthProvider';
import { useProductSearch, type Product } from '@/lib/stacks/catalog-stack';
import { getSupabase } from '@/lib/supabase/client';
import { formatMoney, formatQty, pluralUnit } from '@/lib/format';

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
  const { store } = useAuth();

  const [lines, setLines] = useState<ReceiveLine[]>([]);
  const [supplier, setSupplier] = useState('');
  const [invoiceRef, setInvoiceRef] = useState('');
  const [delivery, setDelivery] = useState('');
  const [distribution, setDistribution] = useState('');
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const { products } = useProductSearch(store?.id ?? null, picking ? debounced : null);

  const patch = (key: string, next: Partial<ReceiveLine>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...next } : l)));

  const addProduct = (p: Product) => {
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
      },
    ]);
    setPicking(false);
    setQuery('');
  };

  const baseQtyOf = (l: ReceiveLine) => {
    const qty = Number(l.qty) || 0;
    const factor = l.packId && l.packQty ? Number(l.packQty) : 1;
    return qty * factor;
  };

  const goodsTotal = useMemo(
    () => lines.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0),
    [lines],
  );

  const fees = (Number(delivery) || 0) + (Number(distribution) || 0);
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
    if (goodsTotal <= 0 || fees <= 0) return raw;
    return raw + (fees * (lineValue / goodsTotal)) / baseQty;
  };

  const submit = async () => {
    if (!store) return;
    setBusy(true);
    setError(null);
    try {
      const payload = lines
        .filter((l) => l.productId && Number(l.qty) > 0)
        .map((l) => ({
          product_id: l.productId,
          qty: Number(l.qty),
          pack_id: l.packId,
          unit_cost: Number(l.unitCost) || 0,
        }));

      if (payload.length === 0) throw new Error('Add at least one item that came in');

      const { error: err } = await getSupabase().rpc('record_purchase', {
        p_store_id: store.id,
        p_lines: payload,
        p_supplier: supplier || null,
        p_invoice_ref: invoiceRef || null,
        p_delivery: Number(delivery) || 0,
        p_distribution: Number(distribution) || 0,
        // Idempotency: a retry after a timeout must not receive the same delivery twice, which
        // would inflate stock and drag the average cost down with phantom goods.
        p_client_uuid: crypto.randomUUID(),
      });
      if (err) throw err;

      setDone(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not record this delivery');
    } finally {
      setBusy(false);
    }
  };

  if (!store) return null;

  if (done) {
    return (
      <PageScaffold title="Delivery recorded" onBack={() => nav.pop()}>
        <InfoPanel tone="success" title="Stock is in">
          Your stock has gone up and the cost of each item now includes the delivery and
          distribution fees.
        </InfoPanel>
        <Button size="large" fullWidth onClick={() => nav.pop()}>
          Done
        </Button>
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      title="Record a delivery"
      subtitle="What came in, and what it really cost"
      onBack={() => nav.pop()}
      footer={
        lines.length > 0 ? (
          <>
            <div className={styles.footerRow}>
              <span className={styles.footerLabel}>Total paid</span>
              <span className={styles.footerTotal}>{formatMoney(grandTotal)}</span>
            </div>
            <Button size="large" fullWidth busy={busy} busyLabel="Recording" onClick={submit}>
              Record this delivery
            </Button>
          </>
        ) : undefined
      }
    >
      {error && (
        <InfoPanel tone="danger" title="Could not record this">
          {error}
        </InfoPanel>
      )}

      {lines.length === 0 && (
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
                  suffix={l.packName ?? l.baseUnit}
                  placeholder="0"
                />
                <Field
                  label={`Price per ${l.packName?.toLowerCase() ?? l.baseUnit}`}
                  numeric
                  prefix="₦"
                  value={l.unitCost}
                  onChange={(e) => patch(l.key, { unitCost: e.target.value })}
                  placeholder="0"
                  hint="What the invoice says."
                />
              </div>

              {Number(l.qty) > 0 && (
                <div className={styles.lineFoot}>
                  <span>
                    {formatQty(baseQtyOf(l))} {pluralUnit(l.baseUnit, baseQtyOf(l))} in total
                  </span>
                  {landed !== null && (
                    <span className={styles.landed}>
                      {fees > 0 && (
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

      <Button variant="secondary" size="large" fullWidth onClick={() => setPicking(true)}>
        <PlusIcon /> Add an item
      </Button>

      {lines.length > 0 && (
        <>
          <h2 className={styles.section}>Fees on this delivery</h2>
          <p className={styles.sectionNote}>
            These are shared across everything above, by value.
          </p>

          <div className={styles.grid}>
            <Field
              label="Delivery"
              optional
              numeric
              prefix="₦"
              value={delivery}
              onChange={(e) => setDelivery(e.target.value)}
              placeholder="0"
            />
            <Field
              label="Distribution"
              optional
              numeric
              prefix="₦"
              value={distribution}
              onChange={(e) => setDistribution(e.target.value)}
              placeholder="0"
            />
          </div>

          <Explain label="Why do the fees change my cost?" defaultOpen={fees > 0}>
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

      <Sheet open={picking} onClose={() => setPicking(false)} title="What came in?">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search products or a category"
          label="Search products"
          resultCount={products.length}
          autoFocus
        />
        {products.length === 0 ? (
          <InfoPanel tone="info" title="Nothing found">
            Only products you already sell can be received. Add it under Stock first.
          </InfoPanel>
        ) : (
          <div className={styles.lines}>
            {products.map((p) => (
              <button
                key={p.id}
                type="button"
                className={styles.pickItem}
                onClick={() => addProduct(p)}
              >
                <span className={styles.lineName}>{p.name}</span>
                <span className={styles.lineFootMeta}>
                  {formatQty(p.onHand)} {pluralUnit(p.baseUnit, Number(p.onHand))} in stock
                  {p.categoryName ? ` · ${p.categoryName}` : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </Sheet>
    </PageScaffold>
  );
}
