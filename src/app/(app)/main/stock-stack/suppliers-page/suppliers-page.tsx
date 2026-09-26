'use client';

import { useNav } from '@academix-admin/navigation-stack';
import { useSearchController } from '@academix-admin/search-viewer';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { SearchLauncher } from '@/components/ui/SearchLauncher';
import { SearchSheet } from '@/components/ui/SearchSheet';
import { PlusIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';
import { SUPPLIERS_SCOPE } from '@/lib/stacks/suppliers';
import { formatMoney, formatQty } from '@/lib/format';
import styles from './suppliers-page.module.css';

interface SupplierAccount {
  id: string;
  name: string;
  phone: string | null;
  owed: number;
  deliveries: number;
  emptiesOut: number;
  lastAt: string | null;
}

/** The one request, so the page and its search cannot drift apart. */
async function readSuppliers(storeId: string): Promise<SupplierAccount[]> {
  const { data, error } = await getSupabase().rpc('suppliers_with_accounts', {
    p_store_id: storeId,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    phone: (r.phone as string | null) ?? null,
    owed: Number(r.owed) || 0,
    deliveries: Number(r.deliveries) || 0,
    emptiesOut: Number(r.empties_out) || 0,
    lastAt: (r.last_at as string | null) ?? null,
  }));
}

const matches = (s: SupplierAccount, text: string) => {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  return s.name.toLowerCase().includes(t) || (s.phone ?? '').includes(t);
};

/**
 * Who the shop buys from, and where it stands with each of them.
 *
 * The mirror of the People screen, and now built like it. It used to have its own arrangement: a
 * `LoadArea`, an `InfoPanel` for emptiness, and an "Add a supplier" button sitting in the body
 * above the list. Three differences from every other list in the app, and the one that cost
 * something real was the state handling — a read that failed showed the same empty panel as a shop
 * with no suppliers, so "your connection dropped" and "you have never bought from anyone" were the
 * same screen. `PageState` tells them apart and offers a retry on one of them.
 *
 * WHAT IS OWED IS THE HEADLINE, because that is the question somebody opens this asking. Containers
 * sit beside it rather than being folded in: money and crates settle separately, on different days,
 * and one figure covering both is a figure nobody can act on.
 */
export default function SuppliersPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { canOpen } = usePermission();
  const [searchId, searchOps, isSearchOpen] = useSearchController();

  const suppliers = useResource<SupplierAccount[]>({
    key: `supplier-accounts:${store?.id ?? 'none'}`,
    scope: SUPPLIERS_SCOPE,
    enabled: Boolean(store),
    deps: [store?.id ?? ''],
    read: () => readSuppliers(store!.id),
  });

  // Coming back from a delivery or a payment, the figures have moved. No polling: the lifecycle
  // says when somebody is actually looking.
  useLiveRefresh(nav, suppliers.reload);

  const rows = suppliers.data ?? [];
  const owedTotal = rows.reduce((sum, r) => sum + Math.max(r.owed, 0), 0);

  const status: PageStatus = !suppliers.loaded
    ? suppliers.error
      ? {
          state: 'error',
          what: 'your suppliers',
          error: suppliers.error,
          onRetry: () => suppliers.reload(),
        }
      : { state: 'loading', what: 'your suppliers' }
    : rows.length === 0
      ? {
          state: 'empty',
          title: 'No suppliers yet',
          body: 'They appear here as soon as you record a delivery from one, or add one with the + above.',
        }
      : { state: 'ready' };

  const open = (id: string) => void nav.push('supplier_account_page', { id });

  const row = (s: SupplierAccount, onClick?: () => void) => (
    <button type="button" className={styles.row} onClick={onClick ?? (() => open(s.id))}>
      <span className={styles.who}>
        <span className={styles.name}>{s.name}</span>
        <span className={styles.meta}>
          {s.deliveries === 0
            ? 'no deliveries yet'
            : `${s.deliveries} ${s.deliveries === 1 ? 'delivery' : 'deliveries'}`}
          {s.emptiesOut > 0 && ` · ${formatQty(s.emptiesOut)} containers back`}
        </span>
      </span>

      <span className={styles.amount}>
        {s.owed > 0 ? (
          <span className={styles.owed}>{formatMoney(s.owed)}</span>
        ) : s.owed < 0 ? (
          /* They owe the shop — a rebate, an overpayment. Said, not hidden. */
          <span className={styles.credit}>{formatMoney(Math.abs(s.owed))} back</span>
        ) : (
          <span className={styles.settled}>settled</span>
        )}
      </span>
    </button>
  );

  return (
    <PageScaffold
      onBack={goBack}
      title="Suppliers"
      subtitle="Who you buy from, and where you stand"
      /*
       * "+" IN THE HEADER, as on People. It was a full-width button in the body, which pushed the
       * list down on every visit for an action taken once in a while — and put "add" in a different
       * place here from everywhere else in the app.
       */
      actions={
        canOpen('supplier_form_page')
          ? [
              {
                key: 'add',
                icon: <PlusIcon />,
                onClick: () => void nav.push('supplier_form_page'),
                ariaLabel: 'Add a supplier',
              },
            ]
          : undefined
      }
    >
      <SearchLauncher
        label="Search suppliers"
        placeholder="Search by name or phone"
        onOpen={searchOps.open}
      />

      {/*
        SEARCHED ON THE DEVICE. `suppliers_with_accounts` returns the whole list — a shop buys from
        tens of suppliers, not thousands — so it is already here and a server round trip per
        keystroke would buy nothing. `queryData` re-reads and filters the same way, which is what
        makes the viewer's paging contract honest rather than a lie that happens not to matter.
      */}
      <SearchSheet<SupplierAccount>
        id={searchId}
        isOpen={isSearchOpen}
        onClose={searchOps.close}
        placeholder="Search by name or phone"
        onInitialData={(text) => rows.filter((s) => matches(s, text))}
        localDataDeps={[rows]}
        queryData={async (_cursor, text) => {
          // Re-read rather than filter the closure's copy: a supplier added on another device
          // should be findable here without leaving the screen first.
          const fresh = store ? await readSuppliers(store.id) : [];
          return { data: fresh.filter((s) => matches(s, text)) };
        }}
        keyOf={(s) => s.id}
        renderRow={(s) =>
          row(s, () => {
            searchOps.close();
            open(s.id);
          })
        }
        emptyText="No supplier matches that."
      />

      <PageState status={status}>
        {() => (
          <>
            <div className={styles.headline}>
              <span className={styles.headlineLabel}>You owe altogether</span>
              <span className={styles.headlineValue}>{formatMoney(owedTotal)}</span>
              <span className={styles.headlineNote}>
                across {rows.filter((r) => r.owed > 0).length} of {rows.length}
              </span>
            </div>

            <ul className={styles.list}>
              {rows.map((s) => (
                <li key={s.id}>{row(s)}</li>
              ))}
            </ul>
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
