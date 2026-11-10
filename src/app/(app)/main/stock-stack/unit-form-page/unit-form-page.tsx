'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNav, useObject } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import styles from './unit-form-page.module.css';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain } from '@/components/ui/Explain';
import { ConfirmDialog, useConfirm } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import {
  archiveStoreUnit,
  createStoreUnit,
  renameStoreUnit,
  useStoreUnits,
  type StoreUnit,
} from '@/lib/stacks/product-units';
import { messageOf } from '@/lib/format';

/**
 * A word this shop measures in — a new one, or (with `id`) one it already has.
 *
 * A form, so a page — the same rule that moved creating a customer out of the picker. A selection
 * viewer is built for a list you scroll and pick from, and a form put inside one inherits a drag
 * handle, snap points and a height meant for rows, then fights the keyboard on a phone.
 *
 * WITH AN `id` it is that word's own page (10 Nov): "Words you measure in" became a list of rows,
 * and a row opens here to be corrected or put away. Pushed with the id alone; the word is read from
 * the shop's list of words, which the list page has already loaded and which is read again here if
 * it has not.
 *
 * THE PLURAL IS ASKED FOR, not guessed. "Boxs" and "Kilogrammes" cannot both come out of adding an
 * "s", and this word ends up printed on receipts customers keep.
 */
export default function UnitFormPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const confirm = useConfirm();

  const id = (location?.params?.id as string | undefined) ?? null;
  const { units, loaded, error, reload } = useStoreUnits(id ? (store?.id ?? null) : null);
  const unit = id ? (units.find((u) => u.id === id) ?? null) : null;
  const products = Number((unit as { products?: number } | null)?.products ?? 0);

  const [name, setName] = useState((location?.params?.name as string | undefined) ?? '');
  const [plural, setPlural] = useState('');
  const [state, setState] = useState<AsyncState>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const [askRetire, setAskRetire] = useState(false);

  // The word as it stands, taken once — a later re-read must not overwrite what is being typed.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !unit) return;
    seeded.current = true;
    setName(unit.name);
    setPlural(unit.plural !== unit.name ? unit.plural : '');
  }, [unit]);

  /*
   * Published GLOBALLY, under the catalogue scope, so this must ask for it the same way.
   *
   * It asked without either, which addresses a page-scoped object by its provider's uid — never
   * found from here. `isProvided` was quietly false, the callback never ran, and a unit somebody
   * had just invented was missing from the picker they came back to.
   */
  const onCreated = useObject<(unit: StoreUnit) => void>('onUnitCreated', {
    global: true,
    scope: 'catalog',
  });

  if (!store) return null;

  const status: PageStatus = !id
    ? { state: 'ready' }
    : unit
      ? { state: 'ready' }
      : !loaded
        ? error
          ? { state: 'error', what: 'this word', error, onRetry: reload }
          : { state: 'loading', what: 'this word' }
        : { state: 'empty', title: 'That word is gone', body: <>It was put away, or never saved.</> };

  const changed =
    unit != null &&
    (name.trim() !== unit.name || (plural.trim() || name.trim()) !== unit.plural);

  const save = async () => {
    setState('busy');
    setProblem(null);
    try {
      if (unit) {
        await renameStoreUnit(unit.id, name.trim() || unit.name, plural.trim() || null);
        reload();
      } else {
        const created = await createStoreUnit(store.id, name.trim(), plural.trim() || name.trim());
        if (onCreated.isProvided) {
          const notify = onCreated.getter();
          if (notify) notify({ id: created, name: name.trim(), plural: plural.trim() || name.trim() });
        }
      }
      setState('idle');
      void nav.pop();
    } catch (e) {
      setState('failed');
      setProblem(messageOf(e, unit ? 'That word could not be changed.' : 'Could not add that unit.'));
    }
  };

  const retire = async () => {
    if (!unit) return;
    setState('busy');
    setProblem(null);
    try {
      await archiveStoreUnit(unit.id);
      reload();
      setState('idle');
      void nav.pop();
    } catch (e) {
      // The server refuses while products are measured in it, and says how many.
      setState('failed');
      setProblem(messageOf(e, 'That word could not be put away.'));
    } finally {
      setAskRetire(false);
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title={id ? (unit?.name ?? 'A word you use') : 'Add a unit you use'}
      subtitle={
        id
          ? products === 0
            ? 'Nothing is measured in it yet'
            : `${products} product${products === 1 ? ' is' : 's are'} measured in it`
          : 'Your own word for how much of something there is'
      }
    >
      <PageState status={status}>
        {() => (
          <>
            {askRetire && unit && (
              <ConfirmDialog
                controller={confirm}
                title={`Put "${unit.name}" away?`}
                message={
                  products > 0
                    ? `${products} product${products === 1 ? ' is' : 's are'} measured in it, so this ` +
                      `will be refused. Change those first.`
                    : 'Nothing is measured in it, so it just stops being offered when you add a shape.'
                }
                confirmText="Put it away"
                tone="danger"
                onDismiss={() => setAskRetire(false)}
                onConfirm={() => void retire()}
              />
            )}

            {id ? (
              <Explain label="What changes if I rename it?">
                Every product measured in it, every receipt they print, and every picker — at once,
                because each points at this word rather than holding its own spelling.
              </Explain>
            ) : (
              <Explain label="What counts as a unit?">
                Whatever you say when somebody asks how much: a crate, a bag, a litre, a keg, a
                bundle. You add it once and it is there for every item after this.
              </Explain>
            )}

            <Field
              label="What is one of them called?"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Crate"
              hint="One of them, not several."
            />

            <Field
              label="And more than one?"
              value={plural}
              onChange={(e) => setPlural(e.target.value)}
              placeholder={name.trim() ? `${name.trim()}s` : 'Crates'}
              optional
              hint="This is what gets printed on receipts. Leave it empty to use the same word."
            />

            {/*
              THE ACTION ENDS THE PAGE rather than being pinned to its foot: a pinned bar costs a
              row of a two-field form on every phone and sits over what is being typed. Putting the
              word away is quieter, and last, away from Save.
            */}
            <div className={styles.actions}>
              <AsyncAction
                state={state}
                problem={problem}
                label={unit ? 'Saving this word' : 'Adding this unit'}
              >
                <Button
                  onClick={() => void save()}
                  disabled={name.trim() === '' || (unit != null && !changed)}
                  fullWidth
                >
                  {unit ? (changed ? 'Save' : 'Nothing changed') : 'Add it'}
                </Button>
              </AsyncAction>
              {unit && (
                <Button variant="ghost" className={styles.retire} fullWidth onClick={() => setAskRetire(true)}>
                  Put this word away
                </Button>
              )}
            </div>
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
