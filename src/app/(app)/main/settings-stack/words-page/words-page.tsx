'use client';

import { useNav } from '@academix-admin/navigation-stack';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import { LinkGroup, LinkRow } from '@/components/ui/LinkGroup';
import { PlusIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import { useStoreUnits } from '@/lib/stacks/product-units';
import styles from './words-page.module.css';

/**
 * The words this shop measures in — Crate, Bottle, Dirica, Paint, Kilogram.
 *
 * A shop invents these as it goes, from the picker, mid-sale, while somebody is waiting — so it
 * invents typos too, and a unit's name is on every product measured in it, every receipt those
 * products print and every picker.
 *
 * A LIST, NOT A WALL OF BOXES (10 Nov). This page was two input boxes per word, a card each, so a
 * shop with forty words scrolled past eighty boxes to fix one. Each word is now a row — the word,
 * its plural, how many products use it — and tapping it opens the word on its own form
 * (`unit_form_page`), where it is corrected or put away. Adding one is the same form, empty.
 *
 * Renaming is safe and retiring is not: every product points at the same unit after a rename, so
 * fixing "Crat" fixes it everywhere; retiring one that products are measured in would leave their
 * shapes naming something no picker offers, and the server refuses, with the count.
 */
export default function WordsPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();
  const { units, loaded, error, reload } = useStoreUnits(store?.id ?? null);

  if (!store) return null;

  const status: PageStatus = !can('products.manage')
    ? {
        // Said inside the page's own header — it used to be a second page with a second header.
        state: 'empty',
        title: 'Ask the owner',
        body: (
          <>
            These words appear on every product and every receipt, so changing them is an owner&rsquo;s
            job.
          </>
        ),
      }
    : !loaded
      ? error
        ? { state: 'error', what: 'your words', error, onRetry: reload }
        : { state: 'loading', what: 'your words' }
      : { state: 'ready' };

  return (
    <PageScaffold
      layout="wide"
      onBack={goBack}
      title="Words you measure in"
      subtitle="Crate, bottle, dirica, paint — whatever you say"
    >
      <PageState status={status}>
        {() => (
          <>
            <InfoPanel tone="info" id="words-what" title="Where these show up">
              On every product measured in one, on every receipt those products print, and in every
              picker. Correcting one here corrects it everywhere at once, because nothing was copied —
              each product points at the word rather than holding its own spelling.
            </InfoPanel>

            <div className={styles.head}>
              <p className={styles.count}>
                {units.length === 0
                  ? 'No words yet'
                  : `${units.length} ${units.length === 1 ? 'word' : 'words'}`}
              </p>
              <Button size="small" onClick={() => void nav.push('unit_form_page')}>
                <PlusIcon /> Add a word
              </Button>
            </div>

            {units.length === 0 ? (
              <p className={styles.none}>
                Add the words you say when somebody asks how much: crate, bottle, carton, bag.
              </p>
            ) : (
              <div className={styles.rows}>
                <LinkGroup>
                  {units.map((unit) => {
                    const products = Number((unit as { products?: number }).products ?? 0);
                    const plural =
                      unit.plural && unit.plural !== unit.name ? ` · ${unit.plural}` : '';
                    return (
                      <LinkRow
                        key={unit.id}
                        title={`${unit.name}${plural}`}
                        note={
                          products === 0
                            ? 'Nothing uses it yet'
                            : `${products} product${products === 1 ? '' : 's'}`
                        }
                        // An id and an intent — the form reads the word from the same list.
                        onClick={() => void nav.push('unit_form_page', { id: unit.id })}
                      />
                    );
                  })}
                </LinkGroup>
              </div>
            )}
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
