'use client';

import { useMemo, useState } from 'react';
import styles from './agent-tools-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { SearchField, useDebounced } from '@/components/ui/SearchField';
import { useStackBack } from '@/hooks/useStackBack';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import { useResource } from '@/lib/stacks/resource';
import { getSupabase } from '@/lib/supabase/client';
import { messageOf } from '@/lib/format';

interface Capability {
  name: string;
  title: string | null;
  description: string | null;
  effect: 'read' | 'write';
  permission: string | null;
  enabled: boolean;
}

/** Where a capability belongs, by the permission it needs: the shop's own words for its areas. */
const AREAS: { label: string; match: (p: string | null, effect: string) => boolean }[] = [
  { label: 'Selling and orders', match: (p) => p === 'sales.record' || p === 'sales.amend' },
  { label: 'Money in and out', match: (p) => p === 'payments.record' },
  { label: 'Expenses', match: (p) => p === 'expenses.record' },
  { label: 'Items, shapes and prices', match: (p) => p === 'products.manage' },
  {
    label: 'Stock and counts',
    match: (p) => !!p && (p.startsWith('stock.') || ['counts.correct', 'period.reopen', 'variance.resolve'].includes(p)),
  },
  { label: 'Deposits and empties', match: (p) => p === 'deposits.manage' },
  { label: 'Customers', match: (p) => p === 'customers.manage' },
  { label: 'Reports', match: (p) => p === 'reports.view' },
  { label: 'Staff', match: (p) => !!p && p.startsWith('staff.') },
  { label: 'Shop settings', match: (p) => p === 'store.settings' },
  { label: 'Checking what others entered', match: (p) => p === 'records.confirm' },
  { label: 'Opening balances', match: (p) => p === 'backfill.manage' },
  { label: 'Looking things up', match: (_p, e) => e === 'read' },
  { label: 'Other changes', match: () => true },
];

const areaOf = (c: Capability) => AREAS.find((a) => a.match(c.permission, c.effect))!.label;

type Show = 'all' | 'read' | 'write' | 'off';

/**
 * WHAT THE AGENT MAY DO — the shop's own switch, under ours.
 *
 * "Switch everything on and have two controls: one from us on the registry, and the store's own."
 * Ours decides what is offered at all (the reviewed crawl). This is the shop's: of everything we
 * offer, what THIS shop's agent may use, each one on until the owner says otherwise (0279). Under both,
 * a person still uses only what their own permissions allow, and nothing is recorded without their YES
 * — said on the page, because "the agent can do everything" is the thing an owner worries about.
 *
 * Grouped by what part of the shop each one touches, searchable, and filterable to "changes records",
 * because those are the ones an owner reads before deciding.
 */
export default function AgentToolsPage() {
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();
  const editable = can('store.settings');
  const problem = useProblem();
  const [query, setQuery] = useState('');
  const q = useDebounced(query, 150).trim().toLowerCase();
  const [show, setShow] = useState<Show>('all');
  const [busy, setBusy] = useState<string | null>(null);

  const res = useResource<Capability[]>({
    key: `agent-capabilities:${store?.id ?? 'none'}`,
    scope: 'settings_flow',
    enabled: Boolean(store),
    read: async () => {
      const { data, error } = await getSupabase().rpc('agent_capabilities', { p_store_id: store!.id });
      if (error) throw error;
      return (data ?? []) as Capability[];
    },
  });
  const all = res.data;

  const groups = useMemo(() => {
    const shown = (all ?? []).filter(
      (c) =>
        (show === 'all' || (show === 'off' ? !c.enabled : c.effect === show)) &&
        (!q || `${c.title ?? ''} ${c.description ?? ''} ${c.name}`.toLowerCase().includes(q)),
    );
    const by = new Map<string, Capability[]>();
    for (const c of shown) by.set(areaOf(c), [...(by.get(areaOf(c)) ?? []), c]);
    return AREAS.map((a) => [a.label, by.get(a.label) ?? []] as const).filter(([, list]) => list.length > 0);
  }, [all, show, q]);

  if (!store) return null;

  const set = async (names: string[], on: boolean, key: string) => {
    setBusy(key);
    // On the page at once; the server's word follows.
    res.set((cur) => (cur ?? []).map((c) => (names.includes(c.name) ? { ...c, enabled: on } : c)));
    try {
      const { error } = await getSupabase().rpc('agent_set_capabilities', { p_store_id: store.id, p_names: names, p_on: on });
      if (error) throw error;
    } catch (e) {
      problem.show(messageOf(e, 'Could not change that'));
      res.reload();
    } finally {
      setBusy(null);
    }
  };

  const status: PageStatus = all
    ? { state: 'ready' }
    : res.error
      ? { state: 'error', what: 'what the agent may do', error: String(res.error), onRetry: res.reload }
      : { state: 'loading', what: 'what the agent may do' };

  const on = (all ?? []).filter((c) => c.enabled).length;

  return (
    <PageScaffold
      layout="record"
      onBack={goBack}
      title="What the agent may do"
      subtitle={all ? `${on} of ${all.length} switched on` : undefined}
    >
      <ProblemDialog problem={problem} title="Not changed" />
      <PageState status={status}>
        {() => (
          <>
            <p className={styles.lead}>
              Everything the shop can do is offered to the agent. Switch off anything this shop&rsquo;s agent
              should not do. Whoever is chatting still uses only what their own permissions allow, and nothing
              is recorded until they reply <strong>YES</strong>.
            </p>
            {!editable && <p className={styles.lead}>Only the owner or a manager can change these.</p>}

            <div className={styles.tools}>
              <SearchField value={query} onChange={setQuery} placeholder="Find one — price, count, statement…" />
              <div className={styles.chips} role="group" aria-label="Which to show">
                {(
                  [
                    ['all', 'All'],
                    ['write', 'Changes records'],
                    ['read', 'Looks up'],
                    ['off', 'Switched off'],
                  ] as [Show, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={show === k}
                    className={`${styles.chip} ${show === k ? styles.chipOn : ''}`}
                    onClick={() => setShow(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {groups.length === 0 && <p className={styles.lead}>Nothing matches.</p>}

            {groups.map(([area, list]) => {
              const allOn = list.every((c) => c.enabled);
              return (
                <section key={area} className={styles.group} aria-label={area}>
                  <header className={styles.groupHead}>
                    <h2 className={styles.groupTitle}>
                      {area} <span className={styles.count}>{list.filter((c) => c.enabled).length}/{list.length}</span>
                    </h2>
                    {editable && (
                      <Button
                        size="small"
                        variant="ghost"
                        busy={busy === area}
                        onClick={() => void set(list.map((c) => c.name), !allOn, area)}
                      >
                        {allOn ? 'Switch all off' : 'Switch all on'}
                      </Button>
                    )}
                  </header>
                  <ul className={styles.list}>
                    {list.map((c) => (
                      <li key={c.name} className={styles.row}>
                        <span className={styles.main}>
                          <span className={styles.title}>{c.title ?? c.name}</span>
                          {c.description && <span className={styles.desc}>{c.description}</span>}
                          <span className={c.effect === 'write' ? styles.tagWrite : styles.tagRead}>
                            {c.effect === 'write' ? 'Changes records · asks YES' : 'Looks up'}
                          </span>
                        </span>
                        <label className={styles.switch}>
                          <input
                            type="checkbox"
                            role="switch"
                            aria-label={c.title ?? c.name}
                            checked={c.enabled}
                            disabled={!editable || busy === c.name}
                            onChange={(e) => void set([c.name], e.target.checked, c.name)}
                          />
                          <span className={styles.track} aria-hidden="true" />
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
