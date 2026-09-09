'use client';

import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { emptiesOwed, recordEmpties } from '@/lib/stacks/customer-ledgers';
import { saidAsPart, type OwedRow } from '@/lib/empties-rollup';
import { formatQty, messageOf } from '@/lib/format';
import styles from './empties-record-page.module.css';

/**
 * Containers coming back, or being written off — a PAGE, because it is a form.
 *
 * It was a bottom sheet, and that was the rule this project already had written down: *a form is a
 * page, a choice is a sheet*. The account screens learnt it the hard way and their own docstring
 * says why — on a phone the keyboard covers the half of the sheet being typed into, dragging to
 * reach a field reads as a dismiss gesture, and there is no back button, so the way out is a
 * gesture somebody has to already know. A sheet's local state does not survive a rotation either,
 * and this form closes an obligation.
 *
 * A sheet is right for CHOOSING one of a list. Three fields and a commit is not that.
 */
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

  const outstanding = (area.data ?? []).filter((r) => r.owed > 0);

  const [pickedShape, setPickedShape] = useState('');
  const [qty, setQty] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);

  const shape = outstanding.find((r) => r.productUnitId === pickedShape) ?? null;
  const tooMany = shape !== null && Number(qty) > shape.owed;
  const damaged = direction === 'damaged';

  const save = async () => {
    if (!store || !customerId || !shape) return;
    setBusy(true);
    try {
      await recordEmpties({
        storeId: store.id,
        customerId,
        productUnitId: shape.productUnitId,
        direction,
        qty: Number(qty),
        reason: why,
      });
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
          outstanding.length === 0 ? (
            <InfoPanel tone="success" title="Nothing is out">
              They are not holding anything of yours.
            </InfoPanel>
          ) : (
            <>
              {/*
                CHOSEN FROM WHAT IS ACTUALLY OWED, not from the whole catalogue.

                A seller can only be handed back something that went out, and offering the shop's
                entire product list here is how a return lands against a beer this customer never
                took.
              */}
              <label className={styles.label} htmlFor="which-shape">
                Which one
              </label>
              <select
                id="which-shape"
                className={styles.select}
                value={pickedShape}
                onChange={(e) => {
                  setPickedShape(e.target.value);
                  setQty('');
                }}
              >
                <option value="">Choose one…</option>
                {outstanding.map((r) => (
                  <option key={r.productUnitId} value={r.productUnitId}>
                    {r.productName} — {saidAsPart(r.owed)}{' '}
                    {r.owed === 1 ? r.unitName : r.unitPlural} owed
                  </option>
                ))}
              </select>

              {shape && (
                <Field
                  label={`How many ${shape.unitPlural.toLowerCase()}`}
                  numeric
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder="0"
                  hint={`They owe ${saidAsPart(shape.owed)}. Part of it is fine — the rest stays out.`}
                  error={tooMany ? `They only owe ${formatQty(shape.owed)}.` : null}
                  autoFocus
                />
              )}

              <Field
                label={damaged ? 'What happened' : 'Note'}
                optional={!damaged}
                value={why}
                onChange={(e) => setWhy(e.target.value)}
                placeholder={damaged ? 'Three cracked in the boot' : 'Anything to remember'}
                hint={
                  damaged
                    ? 'Required. A container written off with no reason is one nobody can explain later.'
                    : undefined
                }
              />

              {/* The actions END the page rather than being pinned to its foot — see CLAUDE.md. */}
              <div className={styles.actions}>
                <Button variant="secondary" onClick={goBack} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant={damaged ? 'danger' : 'primary'}
                  busy={busy}
                  busyLabel="Recording"
                  disabled={!shape || !(Number(qty) > 0) || tooMany || (damaged && !why.trim())}
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
