'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
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
import { countYard, useYard } from '@/lib/stacks/yard';
import styles from '../count-page/count-page.module.css';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { CountedToday } from '@/components/stock/CountedToday';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { usePermission } from '@/hooks/usePermission';
import { COUNTS_SCOPE, countsChanged, useTodaysCounts } from '@/lib/stacks/count-gate';
import { useLoadArea } from '@/components/ui/LoadArea';
import {
  resolveVariance,
  useVarianceReasons,
  type VarianceReason,
} from '@/lib/stacks/variance-reasons';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { PlusIcon, CloseIcon } from '@/components/ui/Icon';

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

/** One line of the account: how many, what happened, and anything worth remembering. */
interface Part {
  key: string;
  /** The treatment the books apply — one of the six the ledger knows. */
  treatment: string;
  /** What the shop called it. */
  label: string;
  /** A PLAIN quantity in base units. The server gives it the variance's sign. */
  qtyBase: number;
  said: string;
  note: string;
}

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
  const { product: active, error: loadError, settled, reload: load } = useProduct(productId);

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
  const {
    byProduct,
    loaded: unitsLoaded,
    error: unitsError,
    reload: reloadUnits,
  } = useSellingUnits(store?.id ?? null);

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

  /*
   * The shapes of THIS item that come back, and the yard's own view of them.
   *
   * `yard_empties` is already loaded store-wide for the yard screen, so this costs no request of
   * its own — and it carries `countedGrain`, which is the whole reason the question can be skipped.
   */
  const {
    shapes: yardRows,
    loaded: yardLoaded,
    error: yardError,
    reload: reloadYard,
  } = useYard(store?.id ?? null);

  const returnable = useMemo(
    /*
     * EVERY SHAPE THAT COMES BACK.
     *
     * This also required `is_counted`, from when that was a tick the shop chose. It is true of
     * every shape now, so the condition selected everything and said nothing — and the shop's rule
     * is the plain one: empties, wherever they are asked about, are the shapes that come back.
     */
    () => shapes.filter((u: SellingUnit) => u.isReturnable),
    [shapes],
  );

  /*
   * ALREADY COUNTED AS ONE STACK, so do not ask again.
   *
   * «if we already count by group (e.g nbl) we just need the sum because we do not need the empties
   * breakdown again» — and it is not merely redundant to ask, it is unanswerable. A shop with one
   * pile of NBL crates cannot say how many of them last held Goldberg, and a box demanding the
   * split would be collecting a guess and recording it as a count.
   */
  /*
   * AN ITEM WITH A MAKER IS COUNTED UNDER THAT MAKER — always, not only once somebody has.
   *
   * This used to skip the empties box only after a maker count existed, so until the first walk of
   * the yard a Goldberg count asked for empty Goldberg crates — and the yard screen then counted the
   * same crates again under NBL. By maker and item by item do not overlap: a crate is a crate
   * whatever was in it last, so only items that belong to NO maker are asked about here.
   */
  const countedByMaker = useMemo(() => {
    const out = new Map<string, string>();
    for (const y of yardRows) {
      if (y.groupId && y.groupName) out.set(y.productUnitId, y.groupName);
    }
    return out;
  }, [yardRows]);

  const emptiesToAsk = useMemo(
    () => returnable.filter((u: SellingUnit) => !countedByMaker.has(u.productUnitId)),
    [returnable, countedByMaker],
  );

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

  /*
   * AND THE EMPTIES OF THIS ITEM, counted on the same walk.
   *
   * A crate is stock too — it is worth money and it is the only part that comes back. Somebody
   * standing in front of Goldberg counting full crates is also looking at the empty ones, and
   * making them come back through another screen to say so is how the yard went uncounted for
   * months while its figure quietly drifted to minus four and a half thousand.
   *
   * Only the shapes this item says come back, and only when the shop is not already counting that
   * maker's crates as one stack — see `countedByMaker` below.
   */
  const [emptiesByShape, setEmptiesByShape] = useState<Record<string, string>>({});

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
  /*
   * THE ACCOUNT OF THE DIFFERENCE — one line per thing that happened, not one reason for the lot.
   *
   * «after counting, before we close, we give account for the missing | additions» — nine bottles
   * short is rarely one story: four were broken, three went out on a sale nobody entered, two nobody
   * can explain. A single chip made somebody pick the biggest cause and quietly mislabel the rest,
   * and the report an owner reads afterwards is exactly the one that was flattened.
   *
   * The parts must add up to the gap EXACTLY — the server refuses anything else, because a remainder
   * is an unexplained shortfall and that is the one thing a period must not close on.
   */
  const {
    reasons,
    loaded: reasonsLoaded,
    error: reasonsError,
    reload: reloadReasons,
  } = useVarianceReasons(store?.id ?? null);
  const [parts, setParts] = useState<Part[]>([]);
  const [picking, setPicking] = useState(false);
  const [partReason, setPartReason] = useState<VarianceReason | null>(null);
  const [partQty, setPartQty] = useState('');
  const [partShape, setPartShape] = useState<string | null>(null);
  const [partNote, setPartNote] = useState('');
  const [note, setNote] = useState('');
  const [done, setDone] = useState(false);

  /*
   * HAS THIS ALREADY BEEN COUNTED TODAY — by anybody, on any device?
   *
   * A day's count is said once (0145). The till may have counted it at nine; a second count here at
   * ten used to overwrite that figure and its counter without a trace. Now the screen asks first, and
   * an item already counted shows that count — the figure, who said it, when, and any corrections —
   * instead of empty boxes. Changing it is a correction, by an owner or manager, with a reason.
   *
   * Re-asked whenever the page comes back into view: another till may have counted it meanwhile.
   */
  const { can } = usePermission();
  const todayIds = useMemo(() => (productId ? [productId] : []), [productId]);
  const {
    byProduct: todays,
    reload: reloadToday,
    loaded: todayLoaded,
    error: todayError,
  } = useTodaysCounts(store?.id ?? null, todayIds);
  useLiveRefresh(nav, reloadToday);
  const today = productId ? todays.get(productId) ?? null : null;

  /* Somebody else's count landed while this one was being typed. Said on the page, not as an error. */
  const [beaten, setBeaten] = useState<string | null>(null);


  useEffect(() => {
    void load();
  }, [load]);

  const variance = state?.variance ?? 0;
  const hasGap = state !== null && Math.abs(variance) > 0.0001;
  // What the gap is worth at what the stock cost — the figure that makes a variance mean something
  // to a shop owner rather than being a count of bottles.
  const lossValue = active && hasGap ? Math.abs(variance) * Number(active.avgUnitCost) : 0;

  /** What the records say about a counted period, next to what was counted. */
  const readPeriod = async (periodId: string): Promise<CountState> => {
    const supabase = getSupabase();
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
    return {
      periodId,
      opening: Number(r.opening_qty),
      receiving: Number(r.receiving_qty),
      sales: Number(r.sales_qty),
      damaged: Number(r.damaged_qty),
      other: Number(r.other_qty),
      expected: Number(r.expected_closing_qty),
      actual: Number(r.actual_closing_qty),
      variance: Number(r.variance_qty),
      withinTolerance: Boolean(within),
    };
  };

  /*
   * COUNTED EARLIER TODAY AND NOT YET CLOSED — so show how it compares, and let it be closed.
   *
   * The till counts mid-sale and never closes; the gap is explained here. Re-read when the figure
   * changes, which is what a correction does.
   */
  const todayPeriod = today?.periodStatus === 'open' ? today.periodId : null;
  const todayFigure = today?.countedBase ?? null;
  /*
   * READ AS PART OF OPENING THE PAGE, not after it. This was an effect that ran once today's count
   * had arrived, so the card appeared, then — a moment later — the sections under it; and a failed
   * read was swallowed, leaving them missing with nothing to press. Kept (keyed by the figure, so a
   * correction reads afresh), so opening the same item again shows it at once.
   */
  const periodArea = useLoadArea(() => readPeriod(todayPeriod as string), [todayPeriod, todayFigure], {
    key: `count-period:${todayPeriod ?? 'none'}:${todayFigure ?? ''}`,
    scope: COUNTS_SCOPE,
    whenNot: !todayPeriod || done,
  });
  useEffect(() => {
    if (periodArea.data && !done) setState(periodArea.data);
  }, [periodArea.data, done]);

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
      if (cErr) {
        /*
         * COUNTED FIRST BY SOMEBODY ELSE — while this was being typed. Not a failure: the item is
         * counted, and the count that stands is shown in place of the boxes.
         */
        if ((cErr as { code?: string }).code === '23505') {
          setBeaten(cErr.message);
          countsChanged();
          return;
        }
        throw cErr;
      }

      /*
       * AND THE EMPTIES, in the same breath.
       *
       * After the shelf count rather than before it, so a failure here cannot lose the answer this
       * screen exists for. Only the boxes somebody actually typed into: a blank is "nobody looked"
       * and must never become a recorded nought — the same rule the yard screen keeps.
       */
      const emptyParts = emptiesToAsk
        .filter((u: SellingUnit) => (emptiesByShape[u.productUnitId] ?? '').trim() !== '')
        .map((u: SellingUnit) => ({
          productUnitId: u.productUnitId,
          qty: Number(emptiesByShape[u.productUnitId]) || 0,
        }));

      if (emptyParts.length > 0 && store) {
        await countYard({
          storeId: store.id,
          parts: emptyParts,
          note: `Counted with the ${active?.name ?? 'item'} shelf`,
        });
      }

      setState(await readPeriod(periodId as string));
      // The till, Take payment and this screen's own card all re-ask.
      countsChanged();
    } catch (e: unknown) {
      submitError.show(messageOf(e, 'Could not save the count'));
    } finally {
      setBusy(false);
    }
  };

  /*
   * WHAT IS STILL UNACCOUNTED FOR, in base units. The account is kept in base units for the same
   * reason the count is: it is the only figure a crate and a bottle can both be added into.
   */
  const accounted = parts.reduce((sum, p) => sum + p.qtyBase, 0);
  const gapBase = state === null || state.variance === null ? 0 : Math.abs(state.variance);
  const leftToAccount = Math.max(0, gapBase - accounted);

  /** The smallest shape the shop names — what a handful of missing bottles is counted in. */
  const smallest = shapes.length > 0 ? shapes[shapes.length - 1] : null;
  const partUnit = shapes.find((u) => u.productUnitId === (partShape ?? smallest?.productUnitId));
  const partBase = (Number(partQty) || 0) * (partUnit?.baseQty ?? 1);

  const canAddPart =
    !!partReason && partBase > 0.0001 && partBase <= leftToAccount + 0.0001;

  const addPart = () => {
    if (!partReason || !canAddPart) return;
    setParts((prev) => [
      ...prev,
      {
        key: `${partReason.label}-${Date.now()}`,
        treatment: partReason.treatment,
        label: partReason.label,
        qtyBase: partBase,
        said:
          shapes.length > 0
            ? stockInShapes(shapes.map((u) => ({ ...u, onHandBase: partBase })))
            : `${formatQty(partBase)}`,
        note: partNote.trim(),
      },
    ]);
    setPartReason(null);
    setPartQty('');
    setPartNote('');
  };

  /** Only the reasons that can explain THIS gap. */
  const reasonsHere = reasons.filter((r) =>
    variance < 0 ? r.direction !== 'over' : r.direction !== 'short',
  );

  /** Explain the gap, then close the period. */
  const resolveAndClose = async () => {
    if (!state) return;
    setBusy(true);
    try {
      const supabase = getSupabase();

      /*
       * EVERY PART, IN ONE CALL.
       *
       * This used to send `p_reason` — an argument `resolve_variance` stopped taking in 0129, when a
       * variance became splittable. Closing a count with a gap failed on the one screen a shop does
       * it from, and the screen said only "Could not close this count".
       */
      if (parts.length > 0) {
        await resolveVariance(
          state.periodId,
          parts.map((p) => ({
            qty: p.qtyBase,
            reason: p.treatment,
            label: p.label,
            note: [p.note.trim(), note.trim()].filter(Boolean).join(' · ') || undefined,
          })),
        );
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

  /*
   * ONE HEADER, and the body waits until it knows enough to ask honestly.
   *
   * Each of these used to start empty and be read as an answer: no count today looked exactly like
   * "not counted yet" (so the boxes were offered for an item already counted, and the second count
   * was refused only on submit), no shapes drew no boxes, and an empty yard asked for the empty
   * crates of an item whose maker's crates are counted as one stack. Once the count is under way
   * (`state`), nothing here pulls it back to a loader.
   */
  const waitFor = (
    loaded: boolean,
    error: string | null,
    what: string,
    onRetry: () => void,
  ): PageStatus | null =>
    loaded ? null : error ? { state: 'error', what, error, onRetry } : { state: 'loading', what };
  const status: PageStatus =
    done || state !== null
      ? { state: 'ready' }
      : settled && !active && !loadError
        ? { state: 'empty', title: 'That item is gone' }
        : (waitFor(Boolean(active), loadError, 'this item', () => void load()) ??
          waitFor(todayLoaded, todayError, "today's count", reloadToday) ??
          waitFor(unitsLoaded, unitsError, 'what it is counted in', reloadUnits) ??
          waitFor(yardLoaded, yardError, 'the empties', reloadYard) ??
          // Counted and still open: the comparison is part of the page, so it arrives with it.
          (todayPeriod
            ? // Reached only while `state` is still empty — including the moment between the figures
              // arriving and being taken into it, which must not draw an empty page for a frame.
              waitFor(false, periodArea.data ? null : periodArea.error, 'how it compares', periodArea.reload)
            : null) ?? { state: 'ready' });

  return (
    <PageScaffold onBack={goBack} title={active?.name ?? 'Count'} subtitle="Check the shelf">
      <ProblemDialog problem={submitError} title="Could not continue" />

      <PageState status={status}>
        {() => (
          <>

      {beaten && !done && (
        <InfoPanel tone="info" title="Somebody counted this first">
          {beaten} Their count stands and yours was not saved — nothing else needs doing.
        </InfoPanel>
      )}

      {/*
        COUNTED TODAY: the count that stands, who said it, and every change since. Shown in place of
        the boxes, because a second count is refused — and a screen that offers one anyway is inviting
        somebody to do the work twice and then be told no.
      */}
      {today && !done && (
        <CountedToday
          storeId={store.id}
          count={today}
          shapes={shapes}
          baseUnit={active?.baseUnit}
        >
          {can('counts.correct') ? (
            <Button
              variant="secondary"
              fullWidth
              onClick={() => void nav.push('count_again_page', { id: productId })}
            >
              Count it again
            </Button>
          ) : (
            <p className={styles.countHint}>
              This count stands until an owner or manager walks the shelf again — and the figure it
              replaces is kept, with the name of whoever entered each.
            </p>
          )}
        </CountedToday>
      )}

      {done ? (
        <InfoPanel tone="success" title="Counted and closed">
          Tomorrow starts from what you counted, not from what the records guessed.
        </InfoPanel>
      ) : today && state === null ? (
        today.periodStatus === 'open' ? null : (
          <InfoPanel tone="success" title="Counted and closed for today">
            The next count starts tomorrow, from this figure.
          </InfoPanel>
        )
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

          {/*
            THE EMPTIES OF THIS ITEM, on the same walk.

            «when product comeback is ticked, we need the empties count as well» — and it belongs
            here rather than on a screen of its own because the person counting full crates of
            Goldberg is standing in front of the empty ones. Optional, because the full shelf is the
            job this screen was opened for and a blank means nobody looked.
          */}
          {emptiesToAsk.length > 0 && (
            <>
              <h2 className={styles.countAsk}>And the empty ones?</h2>
              <div className={styles.shapeBoxes}>
                {emptiesToAsk.map((u: SellingUnit) => (
                  <div className={styles.shapeBox} key={`empty-${u.productUnitId}`}>
                    <Field
                      label={`Empty ${u.plural.toLowerCase()}`}
                      numeric
                      optional
                      value={emptiesByShape[u.productUnitId] ?? ''}
                      onChange={(e) =>
                        setEmptiesByShape((prev) => ({
                          ...prev,
                          [u.productUnitId]: e.target.value,
                        }))
                      }
                      placeholder="—"
                    />
                  </div>
                ))}
              </div>
              <p className={styles.countHint}>
                In your own yard, not the ones customers still have. Leave it blank if you did not
                look; type 0 if you looked and there were none.
              </p>
            </>
          )}

          {/*
            ALREADY ANSWERED, SO NOT ASKED — and said out loud rather than silently skipped.

            A section that simply vanishes reads as a missing feature. Naming the stack it is
            counted in tells somebody where the answer lives.
          */}
          {returnable.length > emptiesToAsk.length && (
            <p className={styles.countHint}>
              The empty{' '}
              {returnable
                .filter((u: SellingUnit) => countedByMaker.has(u.productUnitId))
                .map((u: SellingUnit) => u.plural.toLowerCase())
                .join(' and ')}{' '}
              are counted as part of{' '}
              {[...new Set([...countedByMaker.values()])].join(' and ')} — under &ldquo;Your
              yard&rdquo;, by maker — so there is nothing to enter here.
            </p>
          )}

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
                <strong>{today && !today.countedByYou ? 'Counted' : 'You counted'}</strong>
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
                  {variance < 0 ? 'Some of it is not there' : 'There is more than there should be'}
                </p>
                <p className={styles.gapNumber}>
                  {describeVariance(inUnits(variance), unit?.name ?? active?.baseUnit ?? 'piece')}
                </p>
                {/* WHAT IT MEANS, in one sentence, before anything is asked. */}
                <p className={styles.gapMeaning}>
                  You counted{' '}
                  <strong>
                    {formatQty(Math.abs(inUnits(variance)))}{' '}
                    {unitName(Math.abs(inUnits(variance)))}
                  </strong>{' '}
                  {variance < 0 ? 'fewer than' : 'more than'} your records expected.
                  {lossValue > 0 && (
                    <>
                      {' '}
                      That is <strong>{formatMoney(lossValue)}</strong> at what this stock cost you.
                    </>
                  )}
                </p>
                {state.withinTolerance && (
                  <p className={styles.gapMeaning}>
                    Small enough to be a normal counting difference — you can close without
                    explaining it.
                  </p>
                )}
              </div>

              {/*
                ACCOUNTED FOR LINE BY LINE — one composer, the same shape as fees on a delivery and
                payments on a sale. Pick what happened, say how many, add it; repeat until nothing is
                left over. Only the reasons that can be true of THIS gap are offered: nothing is
                stolen when there is more on the shelf than expected.
              */}
              <p className={styles.reasonLabel}>
                {variance < 0 ? 'Where did it go?' : 'Where did it come from?'}
              </p>

              <p className={styles.accountLeft}>
                {leftToAccount > 0.0001 ? (
                  <>
                    <strong>
                      {formatQty(inUnits(leftToAccount))} {unitName(inUnits(leftToAccount))}
                    </strong>{' '}
                    still to account for
                  </>
                ) : (
                  <>All {formatQty(Math.abs(inUnits(variance)))}{' '}
                  {unitName(Math.abs(inUnits(variance)))} accounted for</>
                )}
              </p>

              {parts.length > 0 && (
                <ul className={styles.partList}>
                  {parts.map((p) => (
                    <li key={p.key} className={styles.partRow}>
                      <span className={styles.partText}>
                        <strong>{p.label}</strong> · {p.said}
                        {p.note && <span className={styles.partNote}>{p.note}</span>}
                      </span>
                      <button
                        type="button"
                        className={styles.partRemove}
                        onClick={() => setParts((prev) => prev.filter((x) => x.key !== p.key))}
                        aria-label={`Remove ${p.label}`}
                      >
                        <CloseIcon />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {leftToAccount > 0.0001 && (
                <div className={styles.composer}>
                  <button
                    type="button"
                    className={styles.pickReason}
                    onClick={() => setPicking(true)}
                  >
                    {partReason ? (
                      <span className={styles.pickChosen}>{partReason.label}</span>
                    ) : (
                      <span className={styles.pickEmpty}>
                        <PlusIcon /> What happened?
                      </span>
                    )}
                  </button>

                  {partReason && (
                    <>
                      <div className={styles.shapeBoxes}>
                        <Field
                          label="How many"
                          numeric
                          value={partQty}
                          onChange={(e) => setPartQty(e.target.value)}
                          placeholder="0"
                          hint={`Up to ${formatQty(inUnits(leftToAccount))} ${unitName(
                            inUnits(leftToAccount),
                          )}`}
                        />
                      </div>

                      {/* WHICH SHAPE the figure is in — a crate of it is not a bottle of it. */}
                      {shapes.length > 1 && (
                        <div className={styles.shapeRow} role="group" aria-label="In what">
                          {shapes.map((u) => (
                            <button
                              key={u.productUnitId}
                              type="button"
                              className={`${styles.shapePick} ${
                                (partShape ?? smallest?.productUnitId) === u.productUnitId
                                  ? styles.shapePickOn
                                  : ''
                              }`}
                              aria-pressed={(partShape ?? smallest?.productUnitId) === u.productUnitId}
                              onClick={() => setPartShape(u.productUnitId)}
                            >
                              {u.plural}
                            </button>
                          ))}
                        </div>
                      )}

                      <Field
                        label="Note"
                        optional
                        value={partNote}
                        onChange={(e) => setPartNote(e.target.value)}
                        placeholder="Who, when, anything worth remembering"
                      />

                      <div className={styles.composerActions}>
                        <Button variant="secondary" onClick={() => setPartReason(null)}>
                          Cancel
                        </Button>
                        <Button disabled={!canAddPart} onClick={addPart}>
                          Add
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}

              <Field
                label="Anything about the whole count?"
                optional
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Kept with every line above"
              />

              <WorkedExample
                label="Why this matters"
                rows={[
                  {
                    label: 'Records expected',
                    value: `${formatQty(inUnits(state.expected))} ${unitName(inUnits(state.expected))}`,
                  },
                  {
                    label: 'You counted',
                    value: `${formatQty(inUnits(state.actual ?? 0))} ${unitName(inUnits(state.actual ?? 0))}`,
                  },
                  {
                    label: 'Not accounted for',
                    value: `${formatQty(Math.abs(inUnits(variance)))} ${unitName(
                      Math.abs(inUnits(variance)),
                    )} · ${formatMoney(lossValue)}`,
                    emphasis: true,
                  },
                ]}
                note="Left unexplained, this quietly shows up as profit you never made."
              />
            </>
          )}
        </>
      )}

          </>
        )}
      </PageState>

      {/* A CHOICE IS A SHEET — and adding one is a pushed page, offered BEFORE the list. */}
      <BottomSheet open={picking} onClose={() => setPicking(false)} title="What happened?">
        <ul className={styles.pickList}>
          <li>
            <button
              type="button"
              className={styles.pickAdd}
              onClick={() => {
                setPicking(false);
                void nav.push('variance_reason_page');
              }}
            >
              <PlusIcon /> A reason of your own
            </button>
          </li>
          {/* Not read yet is not "no reasons": say which. */}
          {!reasonsLoaded && (
            <li>
              {reasonsError ? (
                <InfoPanel tone="danger" title="Could not load the reasons">
                  {reasonsError}{' '}
                  <Button variant="secondary" size="small" onClick={reloadReasons}>
                    Try again
                  </Button>
                </InfoPanel>
              ) : (
                <p className={styles.countHint}>Loading the reasons…</p>
              )}
            </li>
          )}
          {reasonsHere.map((r) => (
            <li key={`${r.id ?? 'builtin'}-${r.label}`}>
              <button
                type="button"
                className={styles.pickRow}
                onClick={() => {
                  setPartReason(r);
                  setPartShape(null);
                  setPicking(false);
                }}
              >
                <span className={styles.pickName}>{r.label}</span>
                {r.hint && <span className={styles.pickMeta}>{r.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>

      <div className={styles.pageAction}>
        {done ? (
          <Button size="large" fullWidth onClick={() => void nav.pop()}>
            Done
          </Button>
        ) : today && state === null ? (
          <Button size="large" fullWidth variant="secondary" onClick={() => void nav.pop()}>
            Back
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
            disabled={hasGap && !state.withinTolerance && leftToAccount > 0.0001}
            onClick={resolveAndClose}
          >
            {hasGap ? 'Account for it and close' : 'Close this count'}
          </Button>
        )}
      </div>
    </PageScaffold>
  );
}
