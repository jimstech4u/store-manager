'use client';

import { useCallback, useState } from 'react';
import styles from './count-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { SearchLauncher } from '@/components/ui/SearchLauncher';
import { SearchSheet } from '@/components/ui/SearchSheet';
import { useSearchController } from '@academix-admin/search-viewer';
import { Explain, InfoPanel, WorkedExample } from '@/components/ui/Explain';
import { ClipboardCheckIcon, WarningIcon } from '@/components/ui/Icon';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useStackBack } from '@/hooks/useStackBack';
import { searchProducts, useProductList, type Product } from '@/lib/stacks/catalog-stack';
import { getSupabase } from '@/lib/supabase/client';
import { describeVariance, formatMoney, formatQty, pluralUnit } from '@/lib/format';

interface CountState {
  periodId: string;
  opening: number;
  receiving: number;
  sales: number;
  damaged: number;
  other: number;
  expected: number;
  actual: number | null;
  variance: number | null;
  withinTolerance: boolean;
}

const REASONS = [
  { code: 'miscount', label: 'I counted wrong', effect: 'The count is corrected. Nothing is lost.' },
  { code: 'theft', label: 'Stolen or missing', effect: 'Recorded as a loss at what the stock cost.' },
  { code: 'unrecorded_sale', label: 'Sold but not entered', effect: 'Recorded as a sale that was missed.' },
  { code: 'unlogged_damage', label: 'Broken or spoiled', effect: 'Recorded as damage.' },
  { code: 'unrecorded_receipt', label: 'Came in but not entered', effect: 'Recorded as stock received.' },
  { code: 'other', label: 'Something else', effect: 'Recorded with your note.' },
] as const;

/**
 * The stock count — CRODS.
 *
 * The screen the whole data model exists to serve. Opening, received, sold and damaged are
 * computed from the movement ledger and shown read-only; the seller enters only what they
 * physically counted, and the gap between the two is the product's core output.
 *
 * The count is entered BEFORE the expected figure is revealed. Showing "should be 857" first
 * invites confirming that number rather than counting the shelf, which would quietly turn the
 * one honest input into a rubber stamp.
 */
export default function CountPage() {
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();

  // Browsing here; searching happens in the sheet, where the results get the whole screen.
  const [searchId, searchOps, isSearchOpen] = useSearchController();

  const browse = useProductList(store?.id ?? null);
  const products = browse.products;

  const [active, setActive] = useState<Product | null>(null);
  const [counted, setCounted] = useState('');
  const [state, setState] = useState<CountState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [done, setDone] = useState(false);

  const reset = useCallback(() => {
    setActive(null);
    setCounted('');
    setState(null);
    setError(null);
    setReason(null);
    setNote('');
    setDone(false);
  }, []);

  /** Submit the physical count and read back what the records expected. */
  const submitCount = async () => {
    if (!active || !store) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = getSupabase();
      const { data: periodId, error: pErr } = await supabase.rpc('ensure_open_period', {
        p_product_id: active.id,
      });
      if (pErr) throw pErr;

      const { error: cErr } = await supabase.rpc('enter_stock_count', {
        p_period_id: periodId,
        p_counted: Number(counted),
      });
      if (cErr) throw cErr;

      const { data: rows, error: rErr } = await supabase
        .from('stock_periods')
        .select(
          'id, opening_qty, receiving_qty, sales_qty, damaged_qty, other_qty,' +
            ' expected_closing_qty, actual_closing_qty, variance_qty',
        )
        .eq('id', periodId)
        .maybeSingle();
      if (rErr) throw rErr;

      const { data: within } = await supabase.rpc('variance_within_tolerance', {
        p_period_id: periodId,
      });

      const r = rows as unknown as Record<string, string>;
      setState({
        periodId: periodId as string,
        opening: Number(r.opening_qty),
        receiving: Number(r.receiving_qty),
        sales: Number(r.sales_qty),
        damaged: Number(r.damaged_qty),
        other: Number(r.other_qty),
        expected: Number(r.expected_closing_qty),
        actual: Number(r.actual_closing_qty),
        variance: Number(r.variance_qty),
        withinTolerance: Boolean(within),
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save the count');
    } finally {
      setBusy(false);
    }
  };

  /** Explain the gap, then close the period. */
  const resolveAndClose = async () => {
    if (!state) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = getSupabase();

      const needsReason = state.variance !== null && Math.abs(state.variance) > 0.0001;
      if (needsReason) {
        if (!reason) throw new Error('Choose what happened before closing');
        const { error: vErr } = await supabase.rpc('resolve_variance', {
          p_period_id: state.periodId,
          p_reason: reason,
          p_note: note || null,
        });
        if (vErr) throw vErr;
      }

      const { error: cErr } = await supabase.rpc('close_stock_period', {
        p_period_id: state.periodId,
      });
      if (cErr) throw cErr;

      setDone(true);
      browse.reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not close this count');
    } finally {
      setBusy(false);
    }
  };

  if (!store) return null;

  if (!can('stock.count')) {
    return (
      <PageScaffold onBack={goBack} title="Count" subtitle="Check the shelf against the records">
        <InfoPanel tone="info" title="Not part of your job here">
          Counting stock and closing the day is done by a manager or the owner.
        </InfoPanel>
      </PageScaffold>
    );
  }

  if (browse.loading && products.length === 0) {
    return <FullPageMessage title="Loading your products" tone="loading" />;
  }

  const variance = state?.variance ?? 0;
  const hasGap = state !== null && Math.abs(variance) > 0.0001;
  const lossValue = active && hasGap ? Math.abs(variance) * Number(active.avgUnitCost) : 0;

  return (
    <PageScaffold title="Count" subtitle="Check the shelf against the records">
      <InfoPanel tone="info" title="Count the shelf, then we compare">
        Pick a product, count what is actually there, and we will tell you whether it matches what
        your records say it should be.
      </InfoPanel>

      <SearchLauncher
        label="Find a product to count"
        placeholder="Search products or a category"
        onOpen={searchOps.open}
      />

      <SearchSheet<Product>
        id={searchId}
        isOpen={isSearchOpen}
        onClose={searchOps.close}
        placeholder="Search products or a category"
        onInitialData={(text) => {
          const t = text.trim().toLowerCase();
          if (!t) return browse.products;
          return browse.products.filter(
            (p) =>
              p.name.toLowerCase().includes(t) ||
              (p.categoryName ?? '').toLowerCase().includes(t),
          );
        }}
        localDataDeps={[browse.products]}
        queryData={async (_cursor, text) => ({ data: await searchProducts(store.id, text) })}
        keyOf={(p) => p.id}
        emptyText="Try part of the name, or a category like “water”."
        renderRow={(p) => (
          <button
            type="button"
            className={styles.row}
            onClick={() => {
              searchOps.close();
              reset();
              setActive(p);
            }}
          >
            <span className={styles.rowMain}>
              <span className={styles.rowName}>{p.name}</span>
              <span className={styles.rowMeta}>
                records say {formatQty(p.onHand)} {pluralUnit(p.baseUnit, Number(p.onHand))}
              </span>
            </span>
            <ClipboardCheckIcon />
          </button>
        )}
      />

      {products.length === 0 ? (
        <InfoPanel tone="info" title="Nothing to count yet">
          Add what you sell under Stock first.
        </InfoPanel>
      ) : (
        <ul className={styles.list}>
          {products.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={styles.row}
                onClick={() => {
                  reset();
                  setActive(p);
                }}
              >
                <span className={styles.rowMain}>
                  <span className={styles.rowName}>{p.name}</span>
                  <span className={styles.rowMeta}>
                    records say {formatQty(p.onHand)} {pluralUnit(p.baseUnit, Number(p.onHand))}
                  </span>
                </span>
                <ClipboardCheckIcon />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* ── Counting sheet ──────────────────────────────────────────────────────── */}
      <BottomSheet
        open={active !== null}
        onClose={reset}
        title={active?.name ?? 'Count'}
        footer={
          done ? (
            <Button size="large" fullWidth onClick={reset}>
              Done
            </Button>
          ) : state === null ? (
            <Button
              size="large"
              fullWidth
              busy={busy}
              busyLabel="Saving"
              disabled={counted.trim() === ''}
              onClick={submitCount}
            >
              Save my count
            </Button>
          ) : (
            <Button
              size="large"
              fullWidth
              busy={busy}
              busyLabel="Closing"
              disabled={hasGap && !state.withinTolerance && !reason}
              onClick={resolveAndClose}
            >
              {hasGap ? 'Explain and close' : 'Close this count'}
            </Button>
          )
        }
      >
        {error && (
          <InfoPanel tone="danger" title="Could not continue">
            {error}
          </InfoPanel>
        )}

        {done ? (
          <InfoPanel tone="success" title="Counted and closed">
            Tomorrow starts from what you counted, not from what the records guessed.
          </InfoPanel>
        ) : state === null ? (
          <>
            {/* Only the input. The expected figure is deliberately not shown yet. */}
            <Field
              label="How many are on the shelf?"
              numeric
              required
              autoFocus
              suffix={active ? pluralUnit(active.baseUnit, Number(counted) || 0) : undefined}
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              hint="Count it yourself. We will show you what the records expect afterwards."
              help={
                <Explain label="Why not show the expected number first?">
                  Because then it stops being a count. Seeing “should be 857” makes it very easy
                  to write 857 and move on — and the whole value of doing this is catching the days
                  when the shelf and the records disagree.
                </Explain>
              }
            />
          </>
        ) : (
          <>
            <div className={styles.crods}>
              {[
                ['O', 'Opening stock', state.opening, ''],
                ['R', 'Received', state.receiving, ''],
                ['S', 'Sold', state.sales, '−'],
                ['D', 'Damaged', state.damaged, '−'],
              ].map(([letter, label, value, sign]) => (
                <div className={styles.crodsRow} key={String(label)}>
                  <span>
                    <span className={styles.letter} aria-hidden="true">
                      {letter}
                    </span>
                    {label}
                  </span>
                  <span className={styles.crodsValue}>
                    {sign}
                    {formatQty(value as number)}
                  </span>
                </div>
              ))}

              <div className={`${styles.crodsRow} ${styles.expectedRow}`}>
                <span>
                  <strong>Should be on the shelf</strong>
                </span>
                <span className={styles.crodsValue}>
                  <strong>{formatQty(state.expected)}</strong>
                </span>
              </div>

              <div className={`${styles.crodsRow} ${styles.countedRow}`}>
                <span>
                  <strong>You counted</strong>
                </span>
                <span className={styles.crodsValue}>
                  <strong>{formatQty(state.actual ?? 0)}</strong>
                </span>
              </div>
            </div>

            {!hasGap ? (
              <InfoPanel tone="success" title="Everything matches">
                The shelf agrees with your records.
              </InfoPanel>
            ) : (
              <>
                <div className={styles.gap} role="alert">
                  <p className={styles.gapHead}>
                    <WarningIcon />
                    {variance < 0 ? 'Stock is missing' : 'More than expected'}
                  </p>
                  <p className={styles.gapNumber}>
                    {describeVariance(variance, active?.baseUnit ?? 'piece')}
                  </p>
                  {lossValue > 0 && (
                    <p className={styles.gapMeaning}>
                      That is <strong>{formatMoney(lossValue)}</strong> at what this stock cost
                      you.
                    </p>
                  )}
                  {state.withinTolerance && (
                    <p className={styles.gapMeaning}>
                      Small enough to be a normal counting difference — you can close without
                      explaining it.
                    </p>
                  )}
                </div>

                <p className={styles.reasonLabel}>What happened?</p>
                <div className={styles.reasons}>
                  {REASONS.map((r) => (
                    <button
                      key={r.code}
                      type="button"
                      className={`${styles.reason} ${reason === r.code ? styles.reasonActive : ''}`}
                      onClick={() => setReason(r.code)}
                      aria-pressed={reason === r.code}
                    >
                      <span className={styles.reasonName}>{r.label}</span>
                      <span className={styles.reasonEffect}>{r.effect}</span>
                    </button>
                  ))}
                </div>

                <Field
                  label="Note"
                  optional
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Anything worth remembering"
                />

                <WorkedExample
                  label="Why this matters"
                  rows={[
                    { label: 'Records expected', value: formatQty(state.expected) },
                    { label: 'Actually there', value: formatQty(state.actual ?? 0) },
                    {
                      label: 'Unaccounted for',
                      value: `${formatQty(Math.abs(variance))} · ${formatMoney(lossValue)}`,
                      emphasis: true,
                    },
                  ]}
                  note="Left unexplained, this quietly shows up as profit you never made."
                />
              </>
            )}
          </>
        )}
      </BottomSheet>
    </PageScaffold>
  );
}
