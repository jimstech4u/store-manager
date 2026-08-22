'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from '../setup.module.css';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel, WorkedExample } from '@/components/ui/Explain';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { getSupabase } from '@/lib/supabase/client';
import { useAuth } from '@/providers/AuthProvider';

/**
 * Opening balances.
 *
 * The step that decides whether a real business can adopt this at all. Nobody starts trading on
 * the day they install software, so the first thing the product must be able to say is "what do
 * you have right now" — stock on the shelf, and money people already owe you.
 *
 * These are recorded as OPENING BALANCES, never as sales or deliveries. A backfilled 340 pieces
 * is not a purchase that happened today; treating it as one would put a fictitious delivery in
 * this week's figures and make the first CRODS period compare against something that never
 * occurred.
 */

interface StockRow {
  key: string;
  name: string;
  baseUnit: string;
  packName: string;
  packQty: string;
  qty: string;
  unitCost: string;
}

interface DebtorRow {
  key: string;
  name: string;
  phone: string;
  amount: string;
}

const newKey = () => Math.random().toString(36).slice(2);

const emptyStock = (): StockRow => ({
  key: newKey(),
  name: '',
  baseUnit: 'piece',
  packName: '',
  packQty: '',
  qty: '',
  unitCost: '',
});

const emptyDebtor = (): DebtorRow => ({ key: newKey(), name: '', phone: '', amount: '' });

export default function OpeningBalancesPage() {
  const router = useRouter();
  const { store, refreshStores } = useAuth();

  const [stock, setStock] = useState<StockRow[]>([emptyStock()]);
  const [debtors, setDebtors] = useState<DebtorRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchStock = (key: string, patch: Partial<StockRow>) =>
    setStock((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const patchDebtor = (key: string, patch: Partial<DebtorRow>) =>
    setDebtors((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = async () => {
    if (!store) return;
    setError(null);
    setBusy(true);

    try {
      const supabase = getSupabase();

      // Sequential rather than Promise.all: a failure halfway through leaves a partial but
      // COHERENT position (some products created, none duplicated), and the owner can re-enter
      // the rest. Firing them in parallel would make "what actually got saved" unanswerable if
      // the connection dropped mid-flight — which on these networks it will.
      for (const row of stock) {
        if (!row.name.trim() || !row.qty) continue;

        const packQty = Number(row.packQty);
        const { data: productId, error: pErr } = await supabase.rpc('create_product', {
          p_store_id: store.id,
          p_name: row.name.trim(),
          p_base_unit: row.baseUnit,
          p_pack_name: row.packName.trim() || null,
          p_pack_qty: row.packName.trim() && packQty > 0 ? packQty : null,
        });
        if (pErr) throw pErr;

        const { error: sErr } = await supabase.rpc('backfill_stock', {
          p_store_id: store.id,
          p_product_id: productId,
          p_qty: Number(row.qty),
          p_unit_cost: row.unitCost ? Number(row.unitCost) : 0,
          // Flagged as an estimate so early margins read as approximate rather than confidently
          // wrong. The first real delivery replaces it with a true landed cost.
          p_estimated: true,
        });
        if (sErr) throw sErr;
      }

      for (const row of debtors) {
        if (!row.name.trim() || !row.amount) continue;

        const { data: customerId, error: cErr } = await supabase.rpc('upsert_customer', {
          p_store_id: store.id,
          p_phone: row.phone.trim(),
          p_display_name: row.name.trim(),
        });
        if (cErr) throw cErr;

        const { error: dErr } = await supabase.rpc('backfill_debtor', {
          p_store_id: store.id,
          p_customer_id: customerId,
          p_amount: Number(row.amount),
        });
        if (dErr) throw dErr;
      }

      const { error: oErr } = await supabase.rpc('complete_onboarding', {
        p_store_id: store.id,
      });
      if (oErr) throw oErr;

      await refreshStores();
      router.replace('/main');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save your opening balances');
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    if (!store) return;
    setBusy(true);
    try {
      await getSupabase().rpc('complete_onboarding', { p_store_id: store.id });
      await refreshStores();
      router.replace('/main');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <p className={styles.step}>Step 2 of 2</p>
        <h1 className={styles.heading}>What you have right now</h1>
        <p className={styles.sub}>
          Your shop did not start today. Enter what is on your shelf and who already owes you, so
          your records begin from where you actually are.
        </p>

        {error && (
          <InfoPanel tone="danger" title="Could not save">
            {error}
          </InfoPanel>
        )}

        {/* ── Stock ─────────────────────────────────────────────────────────────── */}
        <h2 className={styles.sectionTitle}>Stock on your shelf</h2>
        <p className={styles.sectionSub}>
          Add the things you sell. You can add the rest later.
        </p>

        <div className={styles.rowList}>
          {stock.map((row, index) => (
            <div className={styles.row} key={row.key}>
              <div className={styles.rowHead}>
                <span className={styles.rowTitle}>Item {index + 1}</span>
                {stock.length > 1 && (
                  <button
                    type="button"
                    className={styles.removeButton}
                    onClick={() => setStock((rows) => rows.filter((r) => r.key !== row.key))}
                    aria-label={`Remove item ${index + 1}`}
                  >
                    <CloseIcon />
                  </button>
                )}
              </div>

              <Field
                label="What is it?"
                value={row.name}
                onChange={(e) => patchStock(row.key, { name: e.target.value })}
                placeholder="Coca-Cola PET 60cl"
              />

              <div className={styles.grid}>
                <Field
                  label="Pack name"
                  optional
                  value={row.packName}
                  onChange={(e) => patchStock(row.key, { packName: e.target.value })}
                  placeholder="Crate"
                  hint="How you buy it."
                />
                <Field
                  label="Pieces in a pack"
                  optional
                  numeric
                  value={row.packQty}
                  onChange={(e) => patchStock(row.key, { packQty: e.target.value })}
                  placeholder="12"
                />
              </div>

              <div className={styles.grid}>
                <Field
                  label="How many now"
                  numeric
                  suffix="pieces"
                  value={row.qty}
                  onChange={(e) => patchStock(row.key, { qty: e.target.value })}
                  placeholder="0"
                  hint="In single pieces, not packs."
                />
                <Field
                  label="Cost of one piece"
                  numeric
                  prefix="₦"
                  value={row.unitCost}
                  onChange={(e) => patchStock(row.key, { unitCost: e.target.value })}
                  placeholder="0"
                  hint="Your best estimate is fine."
                />
              </div>

              {index === 0 && (
                <Explain label="Why does the cost matter?">
                  <p>
                    Without it we cannot tell you whether a sale made money. Your estimate is
                    marked as a guess, and the first delivery you record replaces it with the
                    real figure — including delivery and distribution fees.
                  </p>
                  <WorkedExample
                    rows={[
                      { label: 'You sell a pack for', value: '₦3,700' },
                      { label: 'It cost you', value: '₦3,400' },
                      { label: 'You made', value: '₦300', emphasis: true },
                    ]}
                  />
                </Explain>
              )}
            </div>
          ))}
        </div>

        <div className={styles.addRow}>
          <Button
            variant="secondary"
            fullWidth
            onClick={() => setStock((rows) => [...rows, emptyStock()])}
          >
            <PlusIcon /> Add another item
          </Button>
        </div>

        {/* ── Debtors ───────────────────────────────────────────────────────────── */}
        <h2 className={styles.sectionTitle}>People who already owe you</h2>
        <p className={styles.sectionSub}>
          Only what is still unpaid today. Leave this out if nobody owes you.
        </p>

        <div className={styles.rowList}>
          {debtors.map((row, index) => (
            <div className={styles.row} key={row.key}>
              <div className={styles.rowHead}>
                <span className={styles.rowTitle}>Person {index + 1}</span>
                <button
                  type="button"
                  className={styles.removeButton}
                  onClick={() => setDebtors((rows) => rows.filter((r) => r.key !== row.key))}
                  aria-label={`Remove person ${index + 1}`}
                >
                  <CloseIcon />
                </button>
              </div>

              <Field
                label="Their name"
                value={row.name}
                onChange={(e) => patchDebtor(row.key, { name: e.target.value })}
                placeholder="Mama Blessing"
              />
              <div className={styles.grid}>
                <Field
                  label="Phone number"
                  type="tel"
                  inputMode="tel"
                  value={row.phone}
                  onChange={(e) => patchDebtor(row.key, { phone: e.target.value })}
                  placeholder="0803 000 0000"
                  hint="How we recognise them later."
                />
                <Field
                  label="Amount owed"
                  numeric
                  prefix="₦"
                  value={row.amount}
                  onChange={(e) => patchDebtor(row.key, { amount: e.target.value })}
                  placeholder="0"
                />
              </div>
            </div>
          ))}
        </div>

        <div className={styles.addRow}>
          <Button
            variant="secondary"
            fullWidth
            onClick={() => setDebtors((rows) => [...rows, emptyDebtor()])}
          >
            <PlusIcon /> Add someone who owes you
          </Button>
        </div>

        <div className={styles.footer}>
          <Button size="large" fullWidth busy={busy} busyLabel="Saving" onClick={submit}>
            Save and start
          </Button>
          <Button variant="ghost" size="large" fullWidth disabled={busy} onClick={skip}>
            Skip for now
          </Button>
        </div>

        <p className={styles.skip}>
          You can add stock, prices and customers at any time.
        </p>
      </div>
    </div>
  );
}
