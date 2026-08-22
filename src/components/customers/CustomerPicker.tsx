'use client';

import { useCallback, useState } from 'react';
import styles from './CustomerPicker.module.css';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { SearchField, useDebounced } from '@/components/ui/SearchField';
import { InfoPanel } from '@/components/ui/Explain';
import { PeopleIcon, PlusIcon } from '@/components/ui/Icon';
import { getSupabase } from '@/lib/supabase/client';
import { usePaginatedList } from '@/hooks/usePaginatedList';
import { formatMoney } from '@/lib/format';

export interface PickedCustomer {
  id: string;
  name: string;
  phone: string;
  balance: number;
}

interface CustomerRow {
  id: string;
  identity_id: string;
  display_name: string;
  business_name: string | null;
  phone: string;
  balance: string;
}

/**
 * Choose a customer, or create one — in one place, at the moment it is actually needed.
 *
 * Deliberately NOT a step at the start of a sale. Most buyers are anonymous walk-ins paying
 * cash, and asking "who is this?" before anything can be added to a receipt is a question the
 * seller usually cannot answer and does not need to. It becomes necessary only when part of the
 * money is going on account, because credit needs somewhere to sit.
 *
 * Searching and creating are the same screen rather than two modes. Typing a name that turns out
 * to exist should attach the existing person — otherwise the same customer accumulates two
 * records and their debt splits between them, which is the failure mode that makes a debtor look
 * settled while owing money.
 */
export function CustomerPicker({
  open,
  onClose,
  onPick,
  storeId,
  /** Prefills the create form when the seller has already typed a name on the order. */
  initialName = '',
}: {
  open: boolean;
  onClose: () => void;
  onPick: (customer: PickedCustomer) => void;
  storeId: string;
  initialName?: string;
}) {
  const [query, setQuery] = useState(initialName);
  const debounced = useDebounced(query);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (cursor: unknown | null, limit: number) => {
      const c = cursor as { name: string; id: string } | null;
      const { data, error: err } = await getSupabase().rpc('list_customers', {
        p_store_id: storeId,
        p_query: debounced.trim() || null,
        p_after_name: c?.name ?? null,
        p_after_id: c?.id ?? null,
        p_limit: limit,
      });
      if (err) throw err;
      const rows = (data ?? []) as CustomerRow[];
      const last = rows[rows.length - 1];
      return {
        rows,
        cursor: last ? { name: last.display_name, id: last.id } : null,
      };
    },
    [storeId, debounced],
  );

  const list = usePaginatedList<CustomerRow>({
    fetchPage,
    getId: (r) => r.id,
    deps: [storeId, debounced],
    enabled: open && !creating,
  });

  const create = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Enter their name');
      return;
    }

    setBusy(true);
    try {
      // upsert_customer resolves the phone to a shared identity first, so a person already known
      // to this shop — or recognised from their number — is attached rather than duplicated.
      const { data, error: err } = await getSupabase().rpc('upsert_customer', {
        p_store_id: storeId,
        p_phone: phone.trim(),
        p_display_name: name.trim(),
      });
      if (err) throw err;

      onPick({ id: data as string, name: name.trim(), phone: phone.trim(), balance: 0 });
      setCreating(false);
      setName('');
      setPhone('');
      setQuery('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save this customer');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={creating ? 'New customer' : 'Who is this for?'}
      footer={
        creating ? (
          <Button size="large" fullWidth busy={busy} busyLabel="Saving" onClick={create}>
            Save and use
          </Button>
        ) : undefined
      }
    >
      {error && (
        <InfoPanel tone="danger" title="Could not continue">
          {error}
        </InfoPanel>
      )}

      {creating ? (
        <>
          <Field
            label="Their name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Mama Blessing"
            autoFocus
            hint="However you would say it — you can search for them this way later."
          />
          <Field
            label="Phone number"
            optional
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="0803 000 0000"
            hint="The surest way to find them again, and it keeps their balance with them even if the name is spelled differently next time."
          />
          <Button variant="ghost" fullWidth onClick={() => setCreating(false)}>
            Back to search
          </Button>
        </>
      ) : (
        <>
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Name or phone number"
            label="Search customers"
            resultCount={list.items.length}
            autoFocus
          />

          {list.items.length === 0 && !list.loading ? (
            <div className={styles.empty}>
              <PeopleIcon size="34px" />
              <p className={styles.emptyTitle}>
                {query.trim() ? 'Nobody by that name yet' : 'No customers saved yet'}
              </p>
              <p>You only need to save someone when they are buying on credit.</p>
            </div>
          ) : (
            <ul className={styles.list}>
              {list.items.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={styles.row}
                    onClick={() =>
                      onPick({
                        id: c.id,
                        name: c.display_name,
                        phone: c.phone,
                        balance: Number(c.balance),
                      })
                    }
                  >
                    <span className={styles.rowMain}>
                      <span className={styles.rowName}>{c.display_name}</span>
                      <span className={styles.rowMeta}>
                        {c.phone}
                        {c.business_name ? ` · ${c.business_name}` : ''}
                      </span>
                    </span>
                    {Number(c.balance) > 0 && (
                      <span className={styles.rowBalance}>
                        owes {formatMoney(c.balance)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className={styles.createRow}>
            <Button
              variant="secondary"
              size="large"
              fullWidth
              onClick={() => {
                // Carry whatever was typed into the new-customer form: having typed a name once,
                // being made to type it again is the kind of small insult that gets a tool
                // abandoned.
                setName(query.trim());
                setCreating(true);
              }}
            >
              <PlusIcon /> {query.trim() ? `Add "${query.trim()}"` : 'Add a new customer'}
            </Button>
          </div>
        </>
      )}
    </Sheet>
  );
}
