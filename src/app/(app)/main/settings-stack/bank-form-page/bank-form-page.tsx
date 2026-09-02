'use client';

import { useEffect, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useBankAccountsState, type BankAccount } from '@/lib/stacks/bank-accounts';
import { getSupabase } from '@/lib/supabase/client';
import styles from './bank-form-page.module.css';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { messageOf } from '@/lib/format';

/**
 * Adding a bank account, or correcting one — a page.
 *
 * This was a bottom sheet, and it is the screen that made the case for the rule. Four fields, one
 * of them numeric, on a phone: the keyboard covers the half you are typing into, the last field
 * and the Save button end up somewhere a thumb cannot reach, and iOS scrolls the whole sheet off
 * the top of the screen trying to help. A page has none of those problems because a page is what
 * the browser is built to scroll.
 *
 * It is also the highest-value edit in the product. The number here is the one a seller reads out
 * to a customer who is about to send money, so a form that loses a keystroke or saves half an
 * account is not a cosmetic problem.
 *
 * ONLY AN ID TRAVELS. Editing resolves the account from `useBankAccountsState` — the same cache
 * the list behind this page reads — so the two cannot disagree, and a pasted link still works from
 * cold because the hook fetches when nothing is cached.
 */

const BLANK = { bank_name: '', account_name: '', account_number: '', is_default: false };

export default function BankFormPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const accountId = (location?.params?.id as string | undefined) ?? null;
  const { accounts, settled, write } = useBankAccountsState(store?.id ?? null);
  const editing = accountId ? (accounts.find((a) => a.id === accountId) ?? null) : null;

  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const problem = useProblem();

  /*
   * Fill from the record once it arrives.
   *
   * A page mounts before the cache has necessarily resolved, so the fields start empty and fill in
   * when the account is found. Keyed on the account itself: opening the form for a second account
   * must not show the first one's details, which is how somebody edits the wrong record.
   */
  useEffect(() => {
    if (editing) {
      setForm({
        bank_name: editing.bank_name,
        account_name: editing.account_name,
        account_number: editing.account_number,
        is_default: editing.is_default,
      });
    } else if (!accountId) {
      // First account is the default automatically — a shop with one account should never have to
      // be told which one to use.
      setForm({ ...BLANK, is_default: accounts.length === 0 });
    }
  }, [editing, accountId, accounts.length]);

  if (!store) return null;

  // Editing something whose record has not arrived yet. The form would otherwise mount empty and
  // fill in underneath somebody's fingers.
  if (accountId && !settled) {
    return (
      <PageScaffold onBack={goBack} title="Loading this account">
        <FullPageMessage title="Loading this account" tone="loading" />
      </PageScaffold>
    );
  }

  const save = async () => {
    setBusy(true);
    try {
      const { data: savedId, error } = await getSupabase().rpc('save_bank_account', {
        p_store_id: store.id,
        p_bank_name: form.bank_name.trim(),
        p_account_name: form.account_name.trim(),
        p_account_number: form.account_number.trim(),
        p_is_default: form.is_default,
        p_id: editing?.id ?? null,
      });
      if (error) throw error;

      /*
       * The list is told, not asked.
       *
       * `settingsChanged()` made the list behind this page and every payment screen re-read — a
       * round trip to learn what was just typed here, with the old details showing until it
       * landed. Everything about the row is on this form; the id comes back from the save.
       */
      const id = (editing?.id ?? (savedId as string | null)) ?? '';
      const row: BankAccount = {
        id,
        bank_name: form.bank_name.trim(),
        account_name: form.account_name.trim(),
        account_number: form.account_number.trim(),
        is_default: form.is_default,
      };

      const others = accounts
        .filter((a) => a.id !== id)
        // Only one account can be the default, and the server has just enforced that.
        .map((a) => (form.is_default ? { ...a, is_default: false } : a));

      write(editing ? [...others, row].sort((a, b) => a.bank_name.localeCompare(b.bank_name)) : [...others, row]);

      await nav.pop();
    } catch (e) {
      problem.show(messageOf(e, 'That account could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title={editing ? 'Edit this account' : 'Add an account'}
      subtitle={
        editing
          ? 'Correct the details customers pay into'
          : 'The account customers transfer money into'
      }
    >
      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={problem} title="Not saved" />

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
            The account the counter reads out unless the seller picks another. Only one account can
            be the main one.
          </span>
        </span>
      </label>

      {/*
        The actions end the page rather than being pinned to its foot — the same arrangement the
        product form uses. A pinned bar costs a row of the form on every phone this runs on, and
        the last thing somebody should see before saving an account number is the account number.
      */}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => void nav.pop()} disabled={busy}>
          Cancel
        </Button>
        <Button busy={busy} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </PageScaffold>
  );
}
