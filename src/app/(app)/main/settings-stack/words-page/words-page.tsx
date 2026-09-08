'use client';

import { useState } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { PlusIcon, TrashIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import { useStoreUnits } from '@/lib/stacks/product-units';
import { getSupabase } from '@/lib/supabase/client';
import { messageOf } from '@/lib/format';
import styles from './words-page.module.css';

/**
 * The words this shop measures in — Crate, Bottle, Dirica, Paint, Kilogram.
 *
 * A shop invents these as it goes, from the picker, mid-sale, while somebody is waiting. Which
 * means it invents typos too, and a unit's name is the single most visible piece of text a shop
 * owns: it is on every product measured in it, on every receipt those products print, and in every
 * picker. Until now it was also the only one that could never be corrected.
 *
 * Renaming is safe and retiring is not, and the screen treats them differently for that reason.
 * Every row still points at the same unit after a rename, so fixing "Crat" fixes it everywhere at
 * once. Retiring one that products are measured in would leave their shapes naming something no
 * picker offers — the server refuses, with the count.
 */
export default function WordsPage() {
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();
  const problem = useProblem();
  const showProblem = problem.show;
  const confirm = useConfirm();

  const { units, reload } = useStoreUnits(store?.id ?? null);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [plural, setPlural] = useState('');
  const [busy, setBusy] = useState(false);
  const [retiring, setRetiring] = useState<{ id: string; name: string; products: number } | null>(
    null,
  );

  /** What each row now says, keyed by id so two being edited are never confused. */
  const [edits, setEdits] = useState<Record<string, { name: string; plural: string }>>({});

  if (!store) return null;

  if (!can('products.manage')) {
    return (
      <PageScaffold onBack={goBack} title="Words you measure in">
        <InfoPanel tone="info" title="Ask the owner">
          These words appear on every product and every receipt, so changing them is an owner&rsquo;s
          job.
        </InfoPanel>
      </PageScaffold>
    );
  }

  const add = async () => {
    setBusy(true);
    try {
      const { error } = await getSupabase().rpc('create_store_unit', {
        p_store_id: store.id,
        p_name: name.trim(),
        p_plural: plural.trim() || `${name.trim()}s`,
      });
      if (error) throw error;
      setName('');
      setPlural('');
      setAdding(false);
      reload();
    } catch (e) {
      showProblem(messageOf(e, 'That word could not be added.'));
    } finally {
      setBusy(false);
    }
  };

  const save = async (id: string, was: { name: string; plural: string }) => {
    const edit = edits[id];
    if (!edit) return;
    setBusy(true);
    try {
      const { error } = await getSupabase().rpc('rename_store_unit', {
        p_unit_id: id,
        p_name: edit.name.trim() || was.name,
        p_plural: edit.plural.trim() || null,
      });
      if (error) throw error;
      setEdits((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      reload();
    } catch (e) {
      showProblem(messageOf(e, 'That word could not be changed.'));
    } finally {
      setBusy(false);
    }
  };

  const retire = async (id: string) => {
    setBusy(true);
    try {
      const { error } = await getSupabase().rpc('archive_store_unit', {
        p_unit_id: id,
        p_restore: false,
      });
      if (error) throw error;
      reload();
    } catch (e) {
      // The server refuses while products are measured in it, and says how many.
      showProblem(messageOf(e, 'That word could not be put away.'));
    } finally {
      setBusy(false);
      setRetiring(null);
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title="Words you measure in"
      subtitle="Crate, bottle, dirica, paint — whatever you say"
    >
      <ProblemDialog problem={problem} title="Not changed" />

      {retiring && (
        <ConfirmDialog
          controller={confirm}
          title={`Put "${retiring.name}" away?`}
          message={
            retiring.products > 0
              ? `${retiring.products} product${retiring.products === 1 ? ' is' : 's are'} measured ` +
                `in it, so this will be refused. Change those first.`
              : 'Nothing is measured in it, so it just stops being offered when you add a shape.'
          }
          confirmText="Put it away"
          tone="danger"
          onDismiss={() => setRetiring(null)}
          onConfirm={() => void retire(retiring.id)}
        />
      )}

      <InfoPanel tone="info" id="words-what" title="Where these show up">
        On every product measured in one, on every receipt those products print, and in every picker.
        Correcting one here corrects it everywhere at once, because nothing was copied — each product
        points at the word rather than holding its own spelling.
      </InfoPanel>

      <ul className={styles.list}>
        {units.map((unit) => {
          const edit = edits[unit.id];
          const products = Number((unit as { products?: number }).products ?? 0);
          const dirty =
            edit != null &&
            (edit.name.trim() !== unit.name || edit.plural.trim() !== unit.plural);

          return (
            <li className={styles.item} key={unit.id}>
              <div className={styles.itemHead}>
                <span className={styles.used}>
                  {products === 0
                    ? 'nothing uses it yet'
                    : `${products} product${products === 1 ? '' : 's'}`}
                </span>
                <button
                  type="button"
                  className={styles.retire}
                  disabled={busy}
                  onClick={() => setRetiring({ id: unit.id, name: unit.name, products })}
                  aria-label={`Put ${unit.name} away`}
                >
                  <TrashIcon />
                </button>
              </div>

              <div className={styles.pair}>
                <Field
                  label="One of them"
                  value={edit ? edit.name : unit.name}
                  onChange={(e) =>
                    setEdits((prev) => ({
                      ...prev,
                      [unit.id]: {
                        name: e.target.value,
                        plural: prev[unit.id]?.plural ?? unit.plural,
                      },
                    }))
                  }
                />
                {/* Asked, not guessed. English plurals are not a rule anybody can write down, and
                    "diricas" and "paints" are the shop's words rather than a dictionary's. */}
                <Field
                  label="More than one"
                  value={edit ? edit.plural : unit.plural}
                  onChange={(e) =>
                    setEdits((prev) => ({
                      ...prev,
                      [unit.id]: {
                        name: prev[unit.id]?.name ?? unit.name,
                        plural: e.target.value,
                      },
                    }))
                  }
                />
              </div>

              {dirty && (
                <Button
                  fullWidth
                  busy={busy}
                  onClick={() => void save(unit.id, { name: unit.name, plural: unit.plural })}
                >
                  Save
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {adding ? (
        <div className={styles.adder}>
          <h2 className={styles.adderTitle}>A new word</h2>
          <div className={styles.pair}>
            <Field
              label="One of them"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Dirica"
              autoFocus
            />
            <Field
              label="More than one"
              optional
              value={plural}
              onChange={(e) => setPlural(e.target.value)}
              placeholder="Diricas"
            />
          </div>
          <div className={styles.adderActions}>
            <Button variant="secondary" fullWidth disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button fullWidth busy={busy} disabled={name.trim() === ''} onClick={() => void add()}>
              Add it
            </Button>
          </div>
        </div>
      ) : (
        <Button size="large" fullWidth onClick={() => setAdding(true)}>
          <PlusIcon /> Add a word
        </Button>
      )}
    </PageScaffold>
  );
}
