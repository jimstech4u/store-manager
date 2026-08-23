'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { EditIcon, PlusIcon, StarIcon, TrashIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import styles from './bank-page.module.css';

/**
 * The accounts this shop collects transfers into.
 *
 * A distributor rarely has one. There is the account customers are given, the one a particular
 * wholesaler pays into, sometimes a personal one for small amounts — and the seller picks between
 * them at the counter depending on who is buying.
 *
 * Before this, the account number was free text on each payment, which meant reading it out from
 * memory and typing it fresh every time. It is the single easiest number in this business to get
 * wrong and the one where getting it wrong sends somebody else's money somewhere else.
 */

interface Account {
  id: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  is_default: boolean;
}

const BLANK = { bank_name: '', account_name: '', account_number: '', is_default: false };

export default function BankPage() {
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Account | null>(null);
  const [form, setForm] = useState(BLANK);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Account | null>(null);

  const load = useCallback(async () => {
    if (!store) return;
    setLoading(true);
    setError(null);
    const { data, error: e } = await getSupabase().rpc('list_bank_accounts', {
      p_store_id: store.id,
    });
    if (e) setError(e.message);
    else setAccounts((data ?? []) as Account[]);
    setLoading(false);
  }, [store]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!store) return null;
  const editable = can('store.settings');

  if (loading && accounts.length === 0) {
    return <FullPageMessage title="Loading your accounts" tone="loading" />;
  }

  const startAdd = () => {
    setEditing(null);
    // First account is the default automatically — a shop with one account should never have to
    // be told which one to use.
    setForm({ ...BLANK, is_default: accounts.length === 0 });
    setProblem(null);
    setOpen(true);
  };

  const startEdit = (a: Account) => {
    setEditing(a);
    setForm({
      bank_name: a.bank_name,
      account_name: a.account_name,
      account_number: a.account_number,
      is_default: a.is_default,
    });
    setProblem(null);
    setOpen(true);
  };

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { error: e } = await getSupabase().rpc('save_bank_account', {
        p_store_id: store.id,
        p_bank_name: form.bank_name.trim(),
        p_account_name: form.account_name.trim(),
        p_account_number: form.account_number.trim(),
        p_is_default: form.is_default,
        p_id: editing?.id ?? null,
      });
      if (e) throw e;
      setOpen(false);
      await load();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That account could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title="Bank accounts"
      subtitle="Where transfers are paid"
      actions={
        editable
          ? [{ key: 'add', icon: <PlusIcon />, onClick: startAdd, ariaLabel: 'Add an account' }]
          : undefined
      }
    >
      <Explain label="Why add more than one?">
        Whichever account is marked <strong>Main</strong> is the one offered first when a customer
        pays by transfer. Any other account you add can be picked instead, on the spot, without
        anybody having to remember a number.
        <br />
        <br />
        Every transfer records which account it went into, so matching your bank statement against
        what the shop recorded is possible at the end of the month.
      </Explain>

      {error && (
        <InfoPanel tone="danger" title="Could not load">
          {error}
        </InfoPanel>
      )}

      {accounts.length === 0 ? (
        <InfoPanel tone="info" title="No accounts yet">
          Add the account your customers transfer into. Until then, a transfer can still be
          recorded — there is just nothing to read out to the customer.
        </InfoPanel>
      ) : (
        <ul className={styles.list}>
          {accounts.map((a) => (
            <li key={a.id} className={styles.row}>
              <div className={styles.rowMain}>
                <p className={styles.number}>{a.account_number}</p>
                <p className={styles.meta}>
                  {a.bank_name}
                  {a.account_name ? ` · ${a.account_name}` : ''}
                </p>
                {a.is_default && (
                  <span className={styles.mainTag}>
                    <StarIcon size="0.9em" /> Main
                  </span>
                )}
              </div>

              {editable && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.iconButton}
                    onClick={() => startEdit(a)}
                    aria-label={`Edit the ${a.bank_name} account`}
                  >
                    <EditIcon size="1.1em" />
                  </button>
                  <button
                    type="button"
                    className={`${styles.iconButton} ${styles.danger}`}
                    onClick={() => setConfirmRemove(a)}
                    aria-label={`Remove the ${a.bank_name} account`}
                  >
                    <TrashIcon size="1.1em" />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!editable && (
        <InfoPanel tone="info" title="You can look, but not change these">
          Only the owner changes where money is collected.
        </InfoPanel>
      )}

      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Edit this account' : 'Add an account'}
        footer={
          <div className={styles.sheetActions}>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button busy={busy} onClick={() => void save()}>
              Save
            </Button>
          </div>
        }
      >
        {problem && (
          <InfoPanel tone="danger" title="Not saved">
            {problem}
          </InfoPanel>
        )}

        <Field
          label="Account number"
          numeric
          value={form.account_number}
          onChange={(e) => setForm({ ...form, account_number: e.target.value })}
          placeholder="0123456789"
          hint="Check this against your bank app before saving it."
          autoFocus
        />

        <Field
          label="Bank"
          value={form.bank_name}
          onChange={(e) => setForm({ ...form, bank_name: e.target.value })}
          placeholder="Access Bank"
        />

        <Field
          label="Account name"
          value={form.account_name}
          onChange={(e) => setForm({ ...form, account_name: e.target.value })}
          placeholder="The name the bank shows"
          hint="Customers check this before they send money."
        />

        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={form.is_default}
            onChange={(e) => setForm({ ...form, is_default: e.target.checked })}
          />
          <span>
            <strong>Offer this one first</strong>
            <span className={styles.toggleNote}>
              The account the counter reads out unless the seller picks another. Only one account
              can be the main one.
            </span>
          </span>
        </label>
      </BottomSheet>

      <BottomSheet
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title="Remove this account?"
        footer={
          <div className={styles.sheetActions}>
            <Button variant="secondary" onClick={() => setConfirmRemove(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!confirmRemove) return;
                await getSupabase().rpc('archive_bank_account', { p_id: confirmRemove.id });
                setConfirmRemove(null);
                await load();
              }}
            >
              Remove it
            </Button>
          </div>
        }
      >
        <p>
          It stops being offered at the counter. Transfers already recorded against it keep their
          record, so your past months still reconcile.
        </p>
      </BottomSheet>
    </PageScaffold>
  );
}
