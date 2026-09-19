'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { Button } from '@/components/ui/Button';
import { UnitsEditor, unitProblems } from '@/components/catalog/UnitsEditor';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useProduct } from '@/lib/stacks/catalog-stack';
import {
  saveProductUnits,
  useProductUnits,
  useStoreUnits,
  type ProductUnit,
  type StoreUnit,
} from '@/lib/stacks/product-units';
import styles from './units-page.module.css';
import { messageOf } from '@/lib/format';

/**
 * How a shop buys and sells one thing, on its own screen.
 *
 * The same editor the product form holds, reached from the product page for an item that already
 * exists — because correcting what a crate holds is a different errand from renaming the item, and
 * making somebody walk the whole form to do it is how a wrong conversion stays wrong.
 *
 * THE PAGE OWNS ONLY WHAT A PAGE OWNS: fetching, saving, and whether Save may be pressed. The
 * questions themselves live in `UnitsEditor`, so this screen and the form cannot drift apart.
 */
export default function UnitsPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const productId = (location?.params?.id as string | undefined) ?? null;
  const { product, settled } = useProduct(productId);
  const {
    units: storeUnits,
    reload: reloadStoreUnits,
    loaded: storeUnitsLoaded,
  } = useStoreUnits(store?.id ?? null);
  const {
    units: fromServer,
    loaded,
    error: unitsError,
    reload: reloadUnits,
  } = useProductUnits(productId);

  const [units, setUnits] = useState<ProductUnit[]>([]);
  const [state, setState] = useState<AsyncState>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * The server's copy, taken once.
   *
   * Copied into local state rather than edited in place: nothing reaches the shop until Save, and
   * a later re-read must not overwrite what somebody is halfway through typing.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !loaded) return;
    seeded.current = true;
    setUnits(fromServer);
  }, [fromServer, loaded]);

  /*
   * A unit invented on the pushed form, on its way back.
   *
   * A pushed page has no return value — `nav.push` resolves when the page is SHOWN, not when it is
   * finished with — so the answer comes back through an object the form looks up by name. Through
   * a ref, because the callback is published once and must not go stale.
   */
  const onUnitCreatedRef = useRef<(unit: StoreUnit) => void>(() => {});
  useEffect(() => {
    const cleanup = nav.provideObject(
      'onUnitCreated',
      () => (unit: StoreUnit) => onUnitCreatedRef.current(unit),
      { global: true, scope: 'catalog' },
    );
    return cleanup;
  }, [nav]);

  onUnitCreatedRef.current = () => reloadStoreUnits();

  if (!store) return null;
  // One header; the body waits for the item and its shapes.
  const status: PageStatus =
    productId && !settled
      ? { state: 'loading', what: 'this item' }
      : !productId || !product
        ? { state: 'empty', title: 'That item is gone' }
        : !loaded
          ? unitsError
            ? { state: 'error', what: 'how you buy and sell it', error: unitsError, onRetry: reloadUnits }
            : { state: 'loading', what: 'how you buy and sell it' }
          : { state: 'ready' };

  const save = async () => {
    setState('busy');
    setProblem(null);
    try {
      if (!productId) return;
      await saveProductUnits(productId, units);
      setState('idle');
      void nav.pop();
    } catch (e) {
      setState('failed');
      // The database's own sentence, which names the unit. Better than anything generic this page
      // could invent, and it is the last word on whether the set adds up.
      setProblem(messageOf(e, 'Could not save this.'));
    }
  };

  return (
    <PageScaffold onBack={goBack} title="The shapes it comes in" subtitle={product?.name}>
      <PageState status={status}>
        {() =>
          product && (
            <>
      <UnitsEditor
        units={units}
        setUnits={setUnits}
        storeUnits={storeUnits}
        storeUnitsLoading={!storeUnitsLoaded}
        onCreateUnit={(name) => void nav.push('unit_form_page', name.trim() ? { name } : undefined)}
      />

      {/*
        The action ENDS the page rather than being pinned to its foot.

        A pinned bar costs a row of the form on every phone this runs on, and this screen is a
        stack of unit cards with a number field in most of them. Scrolling to the end to commit is
        also the honest gesture: the last thing somebody should see before saving is the last
        answer they gave.
      */}
      <div className={styles.actions}>
        <AsyncAction state={state} problem={problem} label="Saving how you buy and sell this">
          <Button onClick={() => void save()} disabled={unitProblems(units) !== null} fullWidth>
            Save
          </Button>
        </AsyncAction>
      </div>
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
