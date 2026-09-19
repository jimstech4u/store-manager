'use client';

import { useMemo, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import {
  depositLedger,
  emptiesOwed,
  recordEmpties,
  writeOffEmpties,
  type DepositMove,
} from '@/lib/stacks/customer-ledgers';
import { accountsChanged } from '@/lib/stacks/customer-account';
import { useSellingUnits, type SellingUnit } from '@/lib/stacks/selling-units';
import { saidAsPart, type OwedRow } from '@/lib/empties-rollup';
import { formatMoney, formatQty, messageOf } from '@/lib/format';
import styles from './empties-record-page.module.css';

/**
 * Containers coming back, or being written off — a PAGE, because it is a form.
 *
 * It was a bottom sheet, and that was the rule this project already had written down: *a form is a
 * page, a choice is a sheet*. On a phone the keyboard covers the half of the sheet being typed into,
 * and a sheet's local state does not survive a rotation — and this form closes an obligation.
 *
 * COUNTED IN EVERY SHAPE THAT COMES BACK. "One crate and three bottles" is what somebody says with
 * the broken load in front of them; one box in the crate's unit made them work out that three
 * bottles is a quarter of a crate. A box per shape the shop ticked as coming back, and the page does
 * the arithmetic against what is actually owed.
 *
 * BROKEN OR LOST CAN TAKE A DAMAGES FEE IN THE SAME BREATH (0151). It was two entries on two screens
 * — this one, and "Keep some for breakage" on the deposit — typed twice and balanced by whoever
 * remembered the second. Tick it, say how much, and both ledgers are written together.
 */

/** One product the customer is holding, with every owed row of it, largest shape first. */
interface Held {
  productId: string;
  productName: string;
  rows: OwedRow[];
}

/** A box on the form: a shape of the product that the shop says comes back. */
interface Box {
  productUnitId: string;
  name: string;
  plural: string;
  baseQty: number;
}

export default function EmptiesRecordPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const problem = useProblem();
  const showProblem = problem.show;

  const customerId = (location?.params?.id as string | undefined) ?? null;
  const direction =
    (location?.params?.direction as 'returned' | 'damaged' | undefined) ?? 'returned';
  const damaged = direction === 'damaged';

  /*
   * Read here rather than handed over from the screen behind.
   *
   * What is owed changes as the seller works — a colleague on another till may have taken a return
   * in the meantime — and settling against a snapshot taken on the previous screen is how somebody
   * records three crates back against an obligation that is already two.
   */
  const area = useLoadArea<OwedRow[]>(() => emptiesOwed(customerId!), [customerId], {
    onFail: showProblem,
    whenNot: !customerId,
  });
  // What the shop is holding of theirs, so the fee can say where it comes from before it is taken.
  const depositArea = useLoadArea<DepositMove[]>(() => depositLedger(customerId!), [customerId], {
    onFail: showProblem,
    whenNot: !customerId || !damaged,
  });
  const held = depositArea.data && depositArea.data.length > 0 ? depositArea.data[0].running : 0;

  const { byProduct } = useSellingUnits(store?.id ?? null);

  /* What they are holding, by product — the shapes of one beer are one choice, not several. */
  const holding = useMemo<Held[]>(() => {
    const map = new Map<string, Held>();
    for (const r of area.data ?? []) {
      if (!(r.owed > 0) || (r.side ?? 'they_hold') !== 'they_hold') continue;
      const h = map.get(r.productId) ?? { productId: r.productId, productName: r.productName, rows: [] };
      h.rows.push(r);
      map.set(r.productId, h);
    }
    for (const h of map.values()) h.rows.sort((a, b) => b.baseQty - a.baseQty);
    return [...map.values()].sort((a, b) => a.productName.localeCompare(b.productName));
  }, [area.data]);

  const [pickedProduct, setPickedProduct] = useState('');
  const [byShape, setByShape] = useState<Record<string, string>>({});
  const [why, setWhy] = useState('');
  const [takeFee, setTakeFee] = useState(false);
  const [fee, setFee] = useState('');
  const [busy, setBusy] = useState(false);

  const picked = holding.find((h) => h.productId === pickedProduct) ?? null;

  /*
   * THE BOXES: every shape of this product the shop ticked as coming back, largest first. Until the
   * shop's shapes have loaded, the shapes it is actually owed in stand in, so the form is never
   * empty.
   */
  const boxes = useMemo<Box[]>(() => {
    if (!picked) return [];
    const known = (byProduct.get(picked.productId) ?? [])
      .filter((u: SellingUnit) => u.isReturnable)
      .map((u: SellingUnit) => ({
        productUnitId: u.productUnitId,
        name: u.name,
        plural: u.plural,
        baseQty: u.baseQty,
      }));
    const fromRows = picked.rows.map((r) => ({
      productUnitId: r.productUnitId,
      name: r.unitName,
      plural: r.unitPlural,
      baseQty: r.baseQty,
    }));
    const all = new Map<string, Box>();
    for (const b of [...known, ...fromRows]) all.set(b.productUnitId, b);
    return [...all.values()].sort((a, b) => b.baseQty - a.baseQty);
  }, [picked, byProduct]);

  /*
   * WHAT EACH OWED ROW IS SETTLED BY.
   *
   * A shape they are owed in settles itself. A shape they are NOT owed in — three bottles against a
   * debt counted in crates — is turned into the owed shape by size: three bottles of a twelve-bottle
   * crate is a quarter of a crate, and that quarter is what comes off.
   */
  const allocation = useMemo(() => {
    const out = new Map<string, { row: OwedRow; qty: number }>();
    if (!picked || picked.rows.length === 0) return out;
    for (const b of boxes) {
      const n = Number(byShape[b.productUnitId]);
      if (!Number.isFinite(n) || n <= 0) continue;
      const own = picked.rows.find((r) => r.productUnitId === b.productUnitId);
      const row = own ?? picked.rows[0];
      const qty = own ? n : (n * b.baseQty) / row.baseQty;
      const had = out.get(row.productUnitId);
      out.set(row.productUnitId, { row, qty: (had?.qty ?? 0) + qty });
    }
    return out;
  }, [picked, boxes, byShape]);

  const parts = [...allocation.values()];
  const over = parts.find((p) => p.qty > p.row.owed + 1e-9) ?? null;

  /* What was written off, in the shapes it was counted in: "Goldberg 60cl: 1 crate 3 bottles". */
  const said = picked
    ? `${picked.productName}: ${boxes
        .map((b) => {
          const n = Number(byShape[b.productUnitId]);
          return Number.isFinite(n) && n > 0
            ? `${formatQty(n)} ${(n === 1 ? b.name : b.plural).toLowerCase()}`
            : null;
        })
        .filter(Boolean)
        .join(' ')}`
    : '';

  const feeAmount = takeFee ? Number(fee) || 0 : 0;
  const fromDeposit = Math.min(feeAmount, Math.max(held, 0));
  const onAccount = feeAmount - fromDeposit;

  const canSave =
    !!picked &&
    parts.length > 0 &&
    !over &&
    (!damaged || why.trim().length > 0) &&
    (!takeFee || feeAmount > 0) &&
    !busy;

  const save = async () => {
    if (!store || !customerId || !picked) return;
    setBusy(true);
    try {
      if (damaged) {
        await writeOffEmpties({
          storeId: store.id,
          customerId,
          parts: parts.map((p) => ({ productUnitId: p.row.productUnitId, qty: p.qty })),
          reason: why,
          said,
          fee: takeFee ? feeAmount : null,
        });
        // A fee moves their deposit, and can add to what they owe.
        if (takeFee) accountsChanged();
      } else {
        for (const p of parts) {
          await recordEmpties({
            storeId: store.id,
            customerId,
            productUnitId: p.row.productUnitId,
            direction,
            qty: p.qty,
            reason: why,
          });
        }
      }
      await nav.pop();
    } catch (e) {
      showProblem(messageOf(e, 'That could not be recorded.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title={damaged ? 'Broken or lost' : 'Empties brought back'}
      subtitle={damaged ? 'Closing it without the containers' : 'Counted in the shape they left in'}
    >
      <ProblemDialog problem={problem} title="Not recorded" />

      {damaged && (
        <InfoPanel tone="info" title="This closes the obligation without the thing">
          On trust, broken, or paid for at the counter. The containers stop being owed and the
          reason stays on the record, which is what makes it answerable later.
        </InfoPanel>
      )}

      <LoadArea area={area} what="what they are holding">
        {() =>
          holding.length === 0 ? (
            <InfoPanel tone="success" title="Nothing is out">
              They are not holding anything of yours.
            </InfoPanel>
          ) : (
            <>
              {/*
                CHOSEN FROM WHAT IS ACTUALLY OWED, not from the whole catalogue — and by product, so
                the crates and bottles of one beer are one choice.
              */}
              <label className={styles.label} htmlFor="which-one">
                Which one
              </label>
              <select
                id="which-one"
                className={styles.select}
                value={pickedProduct}
                onChange={(e) => {
                  setPickedProduct(e.target.value);
                  setByShape({});
                }}
              >
                <option value="">Choose one…</option>
                {holding.map((h) => (
                  <option key={h.productId} value={h.productId}>
                    {h.productName} —{' '}
                    {h.rows
                      .map((r) => `${saidAsPart(r.owed)} ${(r.owed === 1 ? r.unitName : r.unitPlural).toLowerCase()}`)
                      .join(', ')}{' '}
                    owed
                  </option>
                ))}
              </select>

              {picked && (
                <>
                  <p className={styles.label}>How many</p>
                  <div className={styles.shapeBoxes}>
                    {boxes.map((b, i) => (
                      <Field
                        key={b.productUnitId}
                        label={b.plural}
                        numeric
                        value={byShape[b.productUnitId] ?? ''}
                        onChange={(e) =>
                          setByShape((prev) => ({ ...prev, [b.productUnitId]: e.target.value }))
                        }
                        placeholder="0"
                        hint={b.baseQty > 1 ? `one is ${b.baseQty}` : undefined}
                        autoFocus={i === 0}
                      />
                    ))}
                  </div>
                  <p className={styles.hint}>
                    They owe{' '}
                    {picked.rows
                      .map((r) => `${saidAsPart(r.owed)} ${(r.owed === 1 ? r.unitName : r.unitPlural).toLowerCase()}`)
                      .join(' and ')}
                    . Part of it is fine — the rest stays out.
                  </p>
                  {over && (
                    <p className={styles.error} role="alert">
                      That is more than they owe — they have {saidAsPart(over.row.owed)}{' '}
                      {(over.row.owed === 1 ? over.row.unitName : over.row.unitPlural).toLowerCase()}.
                    </p>
                  )}
                </>
              )}

              <Field
                label={damaged ? 'What happened' : 'Note'}
                optional={!damaged}
                value={why}
                onChange={(e) => setWhy(e.target.value)}
                placeholder={damaged ? 'Customer lost it' : 'Anything to remember'}
                hint={
                  damaged
                    ? 'Required. A container written off with no reason is one nobody can explain later.'
                    : undefined
                }
              />

              {/*
                THE DAMAGES FEE, on the same form as the write-off — one entry for one event.
              */}
              {damaged && (
                <>
                  <label className={styles.toggle}>
                    <input
                      type="checkbox"
                      checked={takeFee}
                      onChange={(e) => setTakeFee(e.target.checked)}
                    />
                    <span>
                      <strong>Take a damages fee for it</strong>
                      <span className={styles.toggleNote}>
                        Recorded with the deposit, the same as keeping some for breakage — so the
                        account balances without a second entry.
                      </span>
                    </span>
                  </label>

                  {takeFee && (
                    <>
                      <Field
                        label="How much"
                        numeric
                        prefix="₦"
                        value={fee}
                        onChange={(e) => setFee(e.target.value)}
                        placeholder="0"
                        autoFocus
                      />
                      {/*
                        WHERE THE MONEY COMES FROM, said before it is taken — a condition of the form,
                        so it stays on the page rather than arriving as a surprise afterwards.
                      */}
                      {feeAmount > 0 && (
                        <InfoPanel
                          tone={onAccount > 0 ? 'warning' : 'info'}
                          title={
                            onAccount > 0
                              ? fromDeposit > 0
                                ? `${formatMoney(fromDeposit)} from their deposit, ${formatMoney(onAccount)} added to what they owe`
                                : `${formatMoney(onAccount)} added to what they owe`
                              : `${formatMoney(fromDeposit)} kept from their deposit`
                          }
                        >
                          You are holding {formatMoney(held)} of theirs.{' '}
                          {onAccount > 0
                            ? 'What the deposit does not cover goes on their account, so nothing is lost.'
                            : 'It is kept as breakage, the same as "Keep some of it" on their deposit.'}{' '}
                          Written as: “{said || '…'} — {why.trim() || '…'}”.
                        </InfoPanel>
                      )}
                    </>
                  )}
                </>
              )}

              {/* The actions END the page rather than being pinned to its foot — see CLAUDE.md. */}
              <div className={styles.actions}>
                <Button variant="secondary" onClick={goBack} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant={damaged ? 'danger' : 'primary'}
                  busy={busy}
                  busyLabel="Recording"
                  disabled={!canSave}
                  onClick={() => void save()}
                >
                  Record it
                </Button>
              </div>
            </>
          )
        }
      </LoadArea>
    </PageScaffold>
  );
}
