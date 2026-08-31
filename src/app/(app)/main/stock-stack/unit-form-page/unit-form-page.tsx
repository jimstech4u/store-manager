'use client';

import { useState } from 'react';
import { useLocation, useNav, useObject } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { createStoreUnit, type StoreUnit } from '@/lib/stacks/product-units';

/**
 * A word this shop had no unit for yet.
 *
 * A form, so a page — the same rule that moved creating a customer out of the picker. A selection
 * viewer is built for a list you scroll and pick from, and a form put inside one inherits a drag
 * handle, snap points and a height meant for rows, then fights the keyboard on a phone.
 *
 * THE PLURAL IS ASKED FOR, not guessed. "Boxs" and "Kilogrammes" cannot both come out of adding an
 * "s", and this word ends up printed on receipts customers keep.
 */
export default function UnitFormPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const [name, setName] = useState((location?.params?.name as string | undefined) ?? '');
  const [plural, setPlural] = useState('');
  const [state, setState] = useState<AsyncState>('idle');
  const [problem, setProblem] = useState<string | null>(null);

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

  const save = async () => {
    setState('busy');
    setProblem(null);
    try {
      const id = await createStoreUnit(store.id, name.trim(), plural.trim() || name.trim());
      if (onCreated.isProvided) {
        const notify = onCreated.getter();
        if (notify) notify({ id, name: name.trim(), plural: plural.trim() || name.trim() });
      }
      setState('idle');
      void nav.pop();
    } catch (e) {
      setState('failed');
      setProblem(e instanceof Error ? e.message : 'Could not add that unit.');
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title="Add a unit you use"
      subtitle="Your own word for how much of something there is"
      footer={
        <AsyncAction state={state} problem={problem} label="Adding this unit">
          <Button onClick={() => void save()} disabled={name.trim() === ''} fullWidth>
            Add it
          </Button>
        </AsyncAction>
      }
    >
      <Explain label="What counts as a unit?">
        Whatever you say when somebody asks how much: a crate, a bag, a litre, a keg, a bundle. You
        add it once and it is there for every item after this.
      </Explain>

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
    </PageScaffold>
  );
}
