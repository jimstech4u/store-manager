'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel, WorkedExample } from '@/components/ui/Explain';
import { WarningIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { useProduct } from '@/lib/stacks/catalog-stack';
import { describeVariance, formatMoney, formatQty, pluralUnit, messageOf } from '@/lib/format';
import { leadUnit, stockInShapes, useSellingUnits, type SellingUnit } from '@/lib/stacks/selling-units';
import styles from '../count-page/count-page.module.css';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';

/**
 * Counting one product: a PAGE, not a sheet.
 *
 * It is three steps — enter what is on the shelf, see how that compares with the records, explain
 * any gap and close — with a number field at the start and a reason to pick at the end. A sheet
 * handled that badly on a phone: the keyboard covered the field being typed into, reaching for it
 * could dismiss the whole thing, and there was no back button, so leaving meant a gesture people
 * have to already know.
 *
 * Counting is also the one job here nobody does in a hurry. Someone walks the shelf with the phone
 * in one hand — a screen with a title and a back arrow that survives a rotation suits that far
 * better than a panel that can be swiped away by accident.
 */

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

export default function CountEntryPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const productId = (location?.params?.id as string | undefined) ?? null;
  /*
   * The product being counted, from the same hook the product page uses.
   *
   * Counting is reached from a list of products, so by the time someone opens a count the product
   * has usually already been read — sharing the hook means the name, unit and average cost are on
   * screen at once instead of after another round trip.
   *
   * The count itself below stays local. It is the result of an action taken during THIS visit, not
   * something fetched about the product, and caching it would be caching a keystroke.
   */
  const { product: active, error: loadError, reload: load } = useProduct(productId);

  /*
   * COUNTED IN WHAT THE SHOP SELLS IN, not in base units.
   *
   * Nobody on a shop floor counts 1,596 pieces. They count 133 packs, and a screen that asks for
   * pieces is asking somebody to do twelve times table on a ladder — which is not a count, it is
   * an invitation to write down whatever the records already said.
   *
   * The arithmetic stays in base units, because that is the only figure a delivery and a sale can
   * both be added into. The conversion happens at the two edges: what is typed is multiplied on
   * the way in, and every figure shown is divided on the way out.
   */
  const { byProduct } = useSellingUnits(store?.id ?? null);

  /*
   * EVERY SHAPE THE SHOP KEEPS THIS IN, largest first — the order somebody counts in.
   *
   * `product_selling_units` returns each shape the shop has given a role, so this is the shop's own
   * answer to "what do you count this in?" rather than a guess. One shape is the common case and
   * still gets one box.
   */
  const shapes = useMemo(
    () =>
      [...(byProduct.get(productId ?? '') ?? [])].sort(
        (a: SellingUnit, b: SellingUnit) => b.baseQty - a.baseQty,
      ),
    [byProduct, productId],
  );
  const unit = leadUnit(byProduct.get(productId ?? ''));
  const per = unit?.baseQty ?? 1;

  /** A base-unit figure, said in the unit the shop counts in. */
  const inUnits = (base: number) => base / per;

  /** What one, or several, of them are called. */
  const unitName = (n: number) =>
    unit ? (n === 1 ? unit.name : unit.plural) : pluralUnit(active?.baseUnit ?? 'piece', n);

  /*
   * What was counted, per shape. Keyed by the shape's id so adding or retiring one does not
   * silently move a figure onto a different shape.
   */
  const [byShape, setByShape] = useState<Record<string, string>>({});

  /** The whole count in base units — what the server is told, and what the comparison is made in. */
  const countedBase = useMemo(
    () =>
      shapes.reduce((sum: number, u: SellingUnit) => {
        const n = Number(byShape[u.productUnitId]);
        return sum + (Number.isFinite(n) ? n * u.baseQty : 0);
      }, 0),
    [byShape, shapes],
  );

  /** Whether anybody has said anything at all. Blank and nought are different answers. */
  const anySaid = shapes.some((u) => (byShape[u.productUnitId] ?? '').trim() !== '');
  const [state, setState] = useState<CountState | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * The LOAD error and the ATTEMPT error are different things and get different surfaces.
   *
   * A page that could not load has nothing on it and the message is its whole state — it stays.
   * A save that failed came back from work that was actually done, and a seller who does not
   * notice it presses the button again.
   */
  const submitError = useProblem();
  // A product that would not load and a count that would not submit are different failures with
  // different lifetimes — the first belongs to the cached product, the second to this visit.
  const error = loadError;
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [done, setDone] = useState(false);


  useEffect(() => {
    void load();
  }, [load]);

  const variance = state?.variance ?? 0;
  const hasGap = state !== null && Math.abs(variance) > 0.0001;
  // What the gap is worth at what the stock cost — the figure that makes a variance mean something
  // to a shop owner rather than being a count of bottles.
  const lossValue = active && hasGap ? Math.abs(variance) * Number(active.avgUnitCost) : 0;

  /** Submit the physical count and read back what the records expected. */
  const submitCount = async () => {
    if (!active || !store) return;
    setBusy(true);
    try {
      const supabase = getSupabase();
      const { data: periodId, error: pErr } = await supabase.rpc('ensure_open_period', {
        p_product_id: active.id,
      });
      if (pErr) throw pErr;

      const { error: cErr } = await supabase.rpc('enter_stock_count', {
        p_period_id: periodId,
        // Back into base units, which is the only language the ledger speaks.
        // In base units, added up from every shape — the multiplication is the app's job, not
        // something to do in your head in front of a shelf.
        p_counted: countedBase,
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
      submitError.show(messageOf(e, 'Could not save the count'));
    } finally {
      setBusy(false);
    }
  };

  /** Explain the gap, then close the period. */
  const resolveAndClose = async () => {
    if (!state) return;
    setBusy(true);
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
    } catch (e: unknown) {
      submitError.show(messageOf(e, 'Could not close this count'));
    } finally {
      setBusy(false);
    }
  };

  if (!store || !productId) return null;

  return (
    <PageScaffold onBack={goBack} title={active?.name ?? 'Count'} subtitle="Check the shelf">
      <ProblemDialog problem={submitError} title="Could not continue" />

      {error && (
        <InfoPanel tone="danger" title="Could not load this item">
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
          {/*
            A BOX PER SHAPE, because that is how a shelf is counted.

            One box fixed to the counting shape meant a shelf of three packs and five loose bottles
            had to be entered as 3.208 packs — worked out in somebody's head, in front of the shelf,
            on the one screen whose whole purpose is that what you see can be compared with what the
            records say.
          */}
          {/*
            The question the screen exists to ask.

            It was the single field's label, and replacing that field with one box per shape took it
            with it — leaving two boxes headed "Packs" and "Bottles" and nothing asking anything.
          */}
          <h2 className={styles.countAsk}>How many are on the shelf?</h2>

          <div className={styles.shapeBoxes}>
            {shapes.map((u) => (
              <div className={styles.shapeBox} key={u.productUnitId}>
                <Field
                  label={u.plural}
                  numeric
                  required={shapes.length === 1}
                  value={byShape[u.productUnitId] ?? ''}
                  onChange={(e) =>
                    setByShape((prev) => ({ ...prev, [u.productUnitId]: e.target.value }))
                  }
                  placeholder="0"
                  hint={u.baseQty > 1 ? `one is ${u.baseQty}` : undefined}
                />
              </div>
            ))}
          </div>

          <p className={styles.countHint}>
            Count it yourself. We will show you what the records expect afterwards.
          </p>

          {/*
            The reason the screen is shaped this way, kept with the boxes.

            It was the `help` on the single field this replaced, and it explains the one thing about
            this screen somebody would otherwise think is a bug.
          */}
          <Explain label="Why not show the expected number first?">
            Because then it stops being a count. Seeing “should be 857” makes it very easy to write
            857 and move on — and the whole value of doing this is catching the days when the shelf
            and the records disagree.
          </Explain>

          {/* The arithmetic said back. Nobody should have to trust a multiplication they cannot see. */}
          {anySaid && shapes.length > 1 && (
            <p className={styles.countedSoFar}>
              That is {stockInShapes(shapes.map((u) => ({ ...u, onHandBase: countedBase })))} on the
              shelf
            </p>
          )}
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
                  {formatQty(inUnits(value as number))}
                </span>
              </div>
            ))}

            <div className={`${styles.crodsRow} ${styles.expectedRow}`}>
              <span>
                <strong>Should be on the shelf</strong>
              </span>
              <span className={styles.crodsValue}>
                <strong>
                  {formatQty(inUnits(state.expected))} {unitName(inUnits(state.expected))}
                </strong>
              </span>
            </div>

            <div className={`${styles.crodsRow} ${styles.countedRow}`}>
              <span>
                <strong>You counted</strong>
              </span>
              <span className={styles.crodsValue}>
                <strong>
                  {formatQty(inUnits(state.actual ?? 0))} {unitName(inUnits(state.actual ?? 0))}
                </strong>
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
                  {describeVariance(inUnits(variance), unit?.name ?? active?.baseUnit ?? 'piece')}
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


      <div className={styles.pageAction}>
        {done ? (
          <Button size="large" fullWidth onClick={() => void nav.pop()}>
            Done
          </Button>
        ) : state === null ? (
          <Button
            size="large"
            fullWidth
            busy={busy}
            busyLabel="Saving"
            disabled={!anySaid}
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
        )}
      </div>
    </PageScaffold>
  );
}
