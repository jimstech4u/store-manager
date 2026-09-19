'use client';

import { useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { EditIcon, PlusIcon, StarIcon, TrashIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import { useBankAccountsState } from '@/lib/stacks/bank-accounts';
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

export default function BankPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();

  /*
   * The accounts come from the shared hook, not from a second copy here.
   *
   * This page used to open its own `useDemandState` on the same key `useBankAccounts` uses, with a
   * different shape — a race whichever way round it ran, and it crashed the page outright. There
   * is one reader of that key now, and both this screen and the payment screens go through it.
   */
  const { accounts, error, settled, reload, write } = useBankAccountsState(store?.id ?? null);
  const loading = !settled;

  const [confirmRemove, setConfirmRemove] = useState<Account | null>(null);
  const removeDialog = useConfirm();
  const problem = useProblem();

  /*
   * Nothing reloads after a write any more.
   *
   * There was a `load()` here that called `settingsChanged()` and then re-read every account, to
   * learn something this page had just done. The writes patch the list instead; `reload` stays for
   * the error panel's Try again, which IS a genuine ask.
   */
  if (!store) return null;
  const editable = can('store.settings');

  // One header; the body waits for the accounts rather than the page being replaced by a spinner.
  const status: PageStatus =
    loading && accounts.length === 0 ? { state: 'loading', what: 'your accounts' } : { state: 'ready' };

  /*
   * Adding and editing are a PAGE now, not a sheet on this one.
   *
   * Four fields — one of them the account number a seller reads out to a customer about to send
   * money — is a form, and a form under a keyboard on a phone is not a sheet. Only the id travels;
   * the form resolves the account from the same cache this list reads.
   */
  const startAdd = () => void nav.push('bank_form_page');
  const startEdit = (a: Account) => void nav.push('bank_form_page', { id: a.id });

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
      <PageState status={status}>
        {() =>
          (
            <>
      <Explain label="Why add more than one?">
        Whichever account is marked <strong>Main</strong> is the one offered first when a customer
        pays by transfer. Any other account you add can be picked instead, on the spot, without
        anybody having to remember a number.
        <br />
        <br />
        Every transfer records which account it went into, so matching your bank statement against
        what the shop recorded is possible at the end of the month.
      </Explain>

      {/*
        A failure with a way out of it.

        The panel said what went wrong and offered nothing to do about it, so the only recourse was
        to leave the page and come back. This is the one place a re-read is honest: the shop is
        asking for it.
      */}
      {error && (
        <InfoPanel tone="danger" title="Could not load">
          <p>{error}</p>
          <Button variant="secondary" onClick={() => void reload()}>
            Try again
          </Button>
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

      <ProblemDialog problem={problem} title="Not removed" />

      {/*
        A CONFIRMATION IS A DIALOG, not a sheet — and mounted only while it is being asked, because
        `ConfirmDialog` opens itself on mount.
      */}
      {confirmRemove && (
        <ConfirmDialog
          controller={removeDialog}
          title="Remove this account?"
          message={
            'It stops being offered at the counter. Transfers already recorded against it keep ' +
            'their record, so your past months still reconcile.'
          }
          confirmText="Remove it"
          cancelText="Keep it"
          tone="danger"
          onDismiss={() => setConfirmRemove(null)}
          onConfirm={() => {
            const target = confirmRemove;
            setConfirmRemove(null);
            void (async () => {
              /*
               * The failure is SAID now. This used to ignore the result and take the row off the
               * screen regardless, so a refused removal looked exactly like a successful one.
               */
              const { error } = await getSupabase().rpc('archive_bank_account', { p_id: target.id });
              if (error) {
                problem.show(error.message);
                return;
              }
              // Taken out here rather than re-read: the writer knows which row went.
              write(accounts.filter((a) => a.id !== target.id));
            })();
          }}
        />
      )}
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
