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
import { useProductGroups } from '@/lib/stacks/product-groups';
import styles from './groups-page.module.css';

/**
 * The groups a shop files its products under — NBL, Soft drinks, Water, Provisions.
 *
 * A LIST, NOT A WALL OF BOXES (10 Nov). This page used to be one form per group — a name box in a
 * card for every heading the shop had — so thirty groups was thirty input boxes to scroll past to
 * find one. Now each group is a row that says its name and how much is filed under it, and tapping
 * it opens the group on its own form (`group_form_page`), where it is renamed or put away. Adding
 * one is the same form, empty.
 *
 * RENAMING IS SAFE, RETIRING IS NOT, and the form treats them differently: every product points at
 * the group rather than holding a copy of its name, so correcting it corrects the price list, the
 * pickers and every report at once, while putting one away only stops it being offered.
 *
 * Read through `useProductGroups` — the one owner of `product-groups:<store>`. This page kept its
 * own copy of that key with another scope and shape, which is how two screens disagree.
 */
export default function GroupsPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();
  const { groups, loaded, error, reload } = useProductGroups(store?.id ?? null);

  if (!store) return null;

  const status: PageStatus = !can('products.manage')
    ? {
        // Said inside the page's own header, the way the words screen says it.
        state: 'empty',
        title: 'Ask the owner',
        body: <>Groups decide how every product is filed, so changing them is an owner&rsquo;s job.</>,
      }
    : !loaded
      ? error
        ? { state: 'error', what: 'your groups', error, onRetry: reload }
        : { state: 'loading', what: 'your groups' }
      : { state: 'ready' };

  return (
    <PageScaffold
      layout="wide"
      onBack={goBack}
      title="Groups you file under"
      subtitle="NBL, soft drinks, water — however you sort your shelves"
    >
      <PageState status={status}>
        {() => (
          <>
            <InfoPanel tone="info" id="groups-what" title="Where these show up">
              On the price list you print, in the product picker at the counter, and in what is on
              the shelf. Correcting one here corrects it everywhere at once, because nothing was
              copied — each product points at the group rather than holding its own spelling.
            </InfoPanel>

            <div className={styles.head}>
              <p className={styles.count}>
                {groups.length === 0
                  ? 'No groups yet'
                  : `${groups.length} ${groups.length === 1 ? 'group' : 'groups'}`}
              </p>
              <Button size="small" onClick={() => void nav.push('group_form_page')}>
                <PlusIcon /> Add a group
              </Button>
            </div>

            {groups.length === 0 ? (
              <p className={styles.none}>
                They are the headings on your printed price list, so one per kind of thing you sell
                is usually enough.
              </p>
            ) : (
              <div className={styles.rows}>
                <LinkGroup>
                  {groups.map((group) => (
                    <LinkRow
                      key={group.id}
                      title={group.name}
                      note={
                        group.products === 0
                          ? 'Nothing filed under it yet'
                          : `${group.products} product${group.products === 1 ? '' : 's'}`
                      }
                      // An id and an intent — the form reads the group from the same list.
                      onClick={() => void nav.push('group_form_page', { id: group.id })}
                    />
                  ))}
                </LinkGroup>
              </div>
            )}
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
