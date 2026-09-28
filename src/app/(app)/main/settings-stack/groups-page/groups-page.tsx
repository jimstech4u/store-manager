'use client';

import { useState } from 'react';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { PlusIcon, TrashIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import { useResource } from '@/lib/stacks/resource';
import { CATALOG_SCOPE } from '@/lib/stacks/customer-account';
import { getSupabase } from '@/lib/supabase/client';
import { messageOf } from '@/lib/format';
import styles from './groups-page.module.css';

/**
 * The groups a shop files its products under — NBL, Soft drinks, Water, Provisions.
 *
 * Invented from a picker, mid-sale, while somebody is waiting, exactly the way the measuring
 * words are — so they collect the same typos, and until now they had the same problem: a group
 * called "Bear" could only be retired and replaced, which files every product in it under
 * nothing.
 *
 * RENAMING IS SAFE, RETIRING IS NOT, and this screen treats them differently for that reason.
 * Every product points at the group rather than holding a copy of its name, so correcting it
 * here corrects it in the price list, in the pickers and in every report at once. Retiring one
 * does not move the products out — it only stops the group being offered — so the count is shown
 * before the question is asked.
 */
interface Group {
  id: string;
  name: string;
  products: number;
}

export default function GroupsPage() {
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();
  const problem = useProblem();
  const showProblem = problem.show;
  const confirm = useConfirm();

  const groups = useResource<Group[]>({
    key: `product-groups:${store?.id ?? 'none'}`,
    scope: CATALOG_SCOPE,
    deps: [store?.id ?? ''],
    read: async () => {
      const { data, error } = await getSupabase().rpc('store_product_groups', {
        p_store_id: store!.id,
      });
      if (error) throw error;
      return (data ?? []) as Group[];
    },
    enabled: Boolean(store?.id),
  });

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [retiring, setRetiring] = useState<Group | null>(null);

  /** What each row now says, keyed by id so two being edited are never confused. */
  const [edits, setEdits] = useState<Record<string, string>>({});

  if (!store) return null;

  const add = async () => {
    setBusy(true);
    try {
      const { error } = await getSupabase().rpc('create_product_group', {
        p_store_id: store.id,
        p_name: name.trim(),
      });
      if (error) throw error;
      setName('');
      setAdding(false);
      await groups.reload();
    } catch (e: unknown) {
      showProblem(messageOf(e, 'That group could not be added.'));
    } finally {
      setBusy(false);
    }
  };

  const rename = async (id: string, next: string) => {
    setBusy(true);
    try {
      const { error } = await getSupabase().rpc('rename_product_group', {
        p_category_id: id,
        p_name: next.trim(),
      });
      if (error) throw error;
      // The row goes back to showing what the server now holds, rather than the draft that
      // produced it — otherwise a rename the server tidied (trimmed, cased) looks unsaved.
      setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== id)));
      await groups.reload();
    } catch (e: unknown) {
      showProblem(messageOf(e, 'That group could not be renamed.'));
    } finally {
      setBusy(false);
    }
  };

  const retire = async (id: string) => {
    setBusy(true);
    try {
      const { error } = await getSupabase().rpc('archive_product_group', {
        p_category_id: id,
        p_restore: false,
      });
      if (error) throw error;
      await groups.reload();
    } catch (e: unknown) {
      showProblem(messageOf(e, 'That group could not be put away.'));
    } finally {
      setBusy(false);
      setRetiring(null);
    }
  };

  const status: PageStatus = !can('products.manage')
    ? {
        // Said inside the page's own header, the way the words screen says it.
        state: 'empty',
        title: 'Ask the owner',
        body: <>Groups decide how every product is filed, so changing them is an owner&rsquo;s job.</>,
      }
    : groups.error
      ? { state: 'error', what: 'your groups', error: groups.error, onRetry: groups.reload }
      : groups.data === null
        ? { state: 'loading', what: 'your groups' }
        : { state: 'ready' };

  return (
    <PageScaffold
      onBack={goBack}
      title="Groups you file under"
      subtitle="NBL, soft drinks, water — however you sort your shelves"
    >
      <ProblemDialog problem={problem} title="Not changed" />

      <PageState status={status}>
        {() => (
          <>
            {retiring && (
              <ConfirmDialog
                controller={confirm}
                title={`Put "${retiring.name}" away?`}
                message={
                  retiring.products > 0
                    ? `${retiring.products} product${retiring.products === 1 ? ' is' : 's are'} ` +
                      `filed under it. They keep it — this only stops the group being offered ` +
                      `when you file something new.`
                    : 'Nothing is filed under it, so it just stops being offered.'
                }
                confirmText="Put it away"
                tone="danger"
                onDismiss={() => setRetiring(null)}
                onConfirm={() => void retire(retiring.id)}
              />
            )}

            <InfoPanel tone="info" id="groups-what" title="Where these show up">
              On the price list you print, in the product picker at the counter, and in what is on
              the shelf. Correcting one here corrects it everywhere at once, because nothing was
              copied — each product points at the group rather than holding its own spelling.
            </InfoPanel>

            <ul className={styles.list}>
              {(groups.data ?? []).map((group) => {
                const edit = edits[group.id];
                const dirty = edit != null && edit.trim() !== group.name && edit.trim() !== '';

                return (
                  <li className={styles.item} key={group.id}>
                    <div className={styles.itemHead}>
                      <span className={styles.used}>
                        {group.products === 0
                          ? 'nothing filed under it yet'
                          : `${group.products} product${group.products === 1 ? '' : 's'}`}
                      </span>
                      <button
                        type="button"
                        className={styles.retire}
                        disabled={busy}
                        onClick={() => setRetiring(group)}
                        aria-label={`Put ${group.name} away`}
                      >
                        <TrashIcon />
                      </button>
                    </div>

                    <Field
                      label="Name"
                      value={edit ?? group.name}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [group.id]: e.target.value }))
                      }
                    />

                    {dirty && (
                      <Button
                        variant="secondary"
                        fullWidth
                        busy={busy}
                        busyLabel="Saving"
                        onClick={() => void rename(group.id, edit)}
                      >
                        Save this name
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>

            {(groups.data ?? []).length === 0 && (
              <p className={styles.none}>
                No groups yet. They are the headings on your printed price list, so one per kind of
                thing you sell is usually enough.
              </p>
            )}

            {adding ? (
              <div className={styles.add}>
                <Field
                  label="What is the group called?"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nigerian Breweries"
                />
                <div className={styles.addActions}>
                  <Button
                    fullWidth
                    busy={busy}
                    busyLabel="Adding"
                    disabled={name.trim() === ''}
                    onClick={() => void add()}
                  >
                    Add this group
                  </Button>
                  <Button
                    variant="secondary"
                    fullWidth
                    onClick={() => {
                      setAdding(false);
                      setName('');
                    }}
                  >
                    Not now
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="secondary" fullWidth onClick={() => setAdding(true)}>
                <PlusIcon /> Add a group
              </Button>
            )}
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
