'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNav, useObject } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import styles from './group-form-page.module.css';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain } from '@/components/ui/Explain';
import { ConfirmDialog, useConfirm } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import {
  archiveGroup,
  createGroup,
  renameGroup,
  useProductGroups,
  type ProductGroup,
} from '@/lib/stacks/product-groups';
import { messageOf } from '@/lib/format';

/**
 * A group the shop files under — a new one, or (with `id`) one it already has.
 *
 * A FORM, SO A PAGE, exactly like the unit form beside it. "Make a new group" was a button inside
 * the picker that called `createGroup` directly, and with an empty search box — the state the sheet
 * opens in — it did nothing at all. Naming a record is a form's job even with one field: it can say
 * what the name is for, report a failure, and survive a rotation.
 *
 * WITH AN `id` it is that group's own page (10 Nov): "Groups you file under" became a list of rows,
 * and a row opens here to be renamed or put away. Pushed with the id alone; the group is read from
 * the shop's list of groups (`useProductGroups`), already loaded by the list and read again here if
 * not.
 */
export default function GroupFormPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const confirm = useConfirm();

  const id = (location?.params?.id as string | undefined) ?? null;
  const { groups, loaded, error, reload } = useProductGroups(id ? (store?.id ?? null) : null);
  const group = id ? (groups.find((g) => g.id === id) ?? null) : null;

  // Whatever was typed into the picker's search box arrives as the starting name, so somebody who
  // typed "NBL" and found nothing does not type it again.
  const [name, setName] = useState((location?.params?.name as string | undefined) ?? '');
  const [state, setState] = useState<AsyncState>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const [askRetire, setAskRetire] = useState(false);

  // The name as it stands, taken once — a later re-read must not overwrite what is being typed.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !group) return;
    seeded.current = true;
    setName(group.name);
  }, [group]);

  /*
   * Published GLOBALLY under the catalogue scope, so it is asked for the same way. Asked without
   * either, a page-scoped object is never found from a pushed page: `isProvided` is quietly false
   * and the group somebody just invented is missing from the picker they came back to.
   */
  const onCreated = useObject<(group: ProductGroup) => void>('onGroupCreated', {
    global: true,
    scope: 'catalog',
  });

  if (!store) return null;

  const status: PageStatus = !id
    ? { state: 'ready' }
    : group
      ? { state: 'ready' }
      : !loaded
        ? error
          ? { state: 'error', what: 'this group', error, onRetry: reload }
          : { state: 'loading', what: 'this group' }
        : { state: 'empty', title: 'That group is gone', body: <>It was put away, or never saved.</> };

  const changed = group != null && name.trim() !== '' && name.trim() !== group.name;

  const save = async () => {
    setState('busy');
    setProblem(null);
    try {
      if (group) {
        await renameGroup(group.id, name.trim());
        reload();
      } else {
        const created = await createGroup(store.id, name.trim());
        /*
         * Handed back as a whole row, not an id. A group created ten seconds ago has no products
         * in it — saying so is the only correct answer. The server returns the existing id if the
         * shop already had this group, and joining that one is the right outcome.
         */
        if (onCreated.isProvided) {
          const notify = onCreated.getter();
          if (notify) notify({ id: created, name: name.trim(), products: 0 });
        }
      }
      setState('idle');
      void nav.pop();
    } catch (e) {
      setState('failed');
      setProblem(messageOf(e, group ? 'That group could not be renamed.' : 'Could not make that group.'));
    }
  };

  const retire = async () => {
    if (!group) return;
    setState('busy');
    setProblem(null);
    try {
      await archiveGroup(group.id);
      reload();
      setState('idle');
      void nav.pop();
    } catch (e) {
      setState('failed');
      setProblem(messageOf(e, 'That group could not be put away.'));
    } finally {
      setAskRetire(false);
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title={id ? (group?.name ?? 'A group') : 'Make a new group'}
      subtitle={
        id
          ? group && group.products > 0
            ? `${group.products} product${group.products === 1 ? ' is' : 's are'} filed under it`
            : 'Nothing filed under it yet'
          : 'Usually whoever made it'
      }
    >
      <PageState status={status}>
        {() => (
          <>
            {askRetire && group && (
              <ConfirmDialog
                controller={confirm}
                title={`Put "${group.name}" away?`}
                message={
                  group.products > 0
                    ? `${group.products} product${group.products === 1 ? ' is' : 's are'} filed ` +
                      `under it. They keep it — this only stops the group being offered when you ` +
                      `file something new.`
                    : 'Nothing is filed under it, so it just stops being offered.'
                }
                confirmText="Put it away"
                tone="danger"
                onDismiss={() => setAskRetire(false)}
                onConfirm={() => void retire()}
              />
            )}

            {id ? (
              <Explain label="What changes if I rename it?">
                The price list, the product picker and every report — at once, because each product
                points at the group rather than holding its own spelling.
              </Explain>
            ) : (
              <Explain label="What is a group for?">
                Grouping by who makes something is what makes empties work: a Nigerian Breweries
                crate settles any other Nigerian Breweries crate, whatever was in it. A group is also
                how the shop finds things — every Guinness product together.
              </Explain>
            )}

            <Field
              label="What is the group called?"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nigerian Breweries (NBL)"
              hint="The maker's name as you say it."
            />

            {/* The action ENDS the page rather than being pinned to its foot. */}
            <div className={styles.actions}>
              <AsyncAction
                state={state}
                problem={problem}
                label={group ? 'Saving this group' : 'Making this group'}
              >
                <Button
                  onClick={() => void save()}
                  disabled={name.trim() === '' || (group != null && !changed)}
                  fullWidth
                >
                  {group ? (changed ? 'Save' : 'Nothing changed') : 'Make it'}
                </Button>
              </AsyncAction>
              {group && (
                <Button variant="ghost" className={styles.retire} fullWidth onClick={() => setAskRetire(true)}>
                  Put this group away
                </Button>
              )}
            </div>
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
