'use client';

import { useState } from 'react';
import { useLocation, useNav, useObject } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import styles from './group-form-page.module.css';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { createGroup, type ProductGroup } from '@/lib/stacks/product-groups';
import { messageOf } from '@/lib/format';

/**
 * A group this shop had no name for yet — usually whoever made the thing.
 *
 * A FORM, SO A PAGE, exactly like the unit form beside it. "Make a new group" was a button inside
 * the picker that called `createGroup` directly, and its handler opened with
 * `if (!storeId || !typed.trim()) return;` — so pressing it with an empty search box, which is the
 * state the sheet opens in, did nothing at all. No error, no page, no group. A control that reads
 * "Make a new group" and silently returns is worse than a missing one.
 *
 * Naming a record is a form's job even when the form has one field: it can say what the name is
 * for, it can report a failure, and it survives a rotation. The unit form learnt the same thing
 * when creating a unit was lifted out of its picker.
 */
export default function GroupFormPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  // Whatever was typed into the picker's search box arrives as the starting name, so somebody who
  // typed "NBL" and found nothing does not type it again.
  const [name, setName] = useState((location?.params?.name as string | undefined) ?? '');
  const [state, setState] = useState<AsyncState>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * Published GLOBALLY under the catalogue scope, so it is asked for the same way.
   *
   * The unit form got this wrong once by asking without either, which addresses a page-scoped
   * object by its provider's uid and is never found from a pushed page: `isProvided` was quietly
   * false, the callback never ran, and the thing somebody had just invented was missing from the
   * picker they came back to.
   */
  const onCreated = useObject<(group: ProductGroup) => void>('onGroupCreated', {
    global: true,
    scope: 'catalog',
  });

  if (!store) return null;

  const save = async () => {
    setState('busy');
    setProblem(null);
    try {
      const id = await createGroup(store.id, name.trim());

      /*
       * Handed back as a whole row, not an id.
       *
       * A group created ten seconds ago has no products in it — saying so is the only correct
       * answer, not a guess, which is why this row can be complete. The server returns the
       * existing id if the shop already had this group, and joining that one is the right outcome:
       * a shop that forgot it had a Nigerian Breweries group gets that group, not a telling-off.
       */
      if (onCreated.isProvided) {
        const notify = onCreated.getter();
        if (notify) notify({ id, name: name.trim(), products: 0 });
      }
      setState('idle');
      void nav.pop();
    } catch (e) {
      setState('failed');
      setProblem(messageOf(e, 'Could not make that group.'));
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title="Make a new group"
      subtitle="Usually whoever made it"
    >
      <Explain label="What is a group for?">
        Grouping by who makes something is what makes empties work: a Nigerian Breweries crate
        settles any other Nigerian Breweries crate, whatever was in it. A group is also how the
        shop finds things — every Guinness product together.
      </Explain>

      <Field
        label="What is the group called?"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Nigerian Breweries (NBL)"
        hint="The maker's name as you say it."
      />

      {/* The action ENDS the page rather than being pinned to its foot. */}
      <div className={styles.actions}>
        <AsyncAction state={state} problem={problem} label="Making this group">
          <Button onClick={() => void save()} disabled={name.trim() === ''} fullWidth>
            Make it
          </Button>
        </AsyncAction>
      </div>
    </PageScaffold>
  );
}
