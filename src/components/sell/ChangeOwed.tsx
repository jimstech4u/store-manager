'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { getSupabase } from '@/lib/supabase/client';
import { accountsChanged } from '@/lib/stacks/customer-account';
import { useBankAccounts } from '@/lib/stacks/bank-accounts';
import { formatMoney, messageOf } from '@/lib/format';
import styles from './ChangeOwed.module.css';

type Method = 'cash' | 'transfer' | 'pos';

/**
 * CHANGE OWED ON A RECEIPT, given back where it is read — like the empties block.
 *
 * "We can settle that change just like we settle empties before printing the receipt ... so customers
 * bring it back and get their change if we don't have it yet." On a fresh receipt it is given at the
 * sale's moment (`atSale`), so the paper printed next says "Change given"; on an older one, now.
 * The shop picks what the change went back in (0246).
 *
 * AT THE COUNTER THE PAPER WAITS FOR IT (11 Nov): printing by itself ran its countdown while the change
 * was still being counted out, and the paper said "owed" for change already in the customer's hand. So
 * it is a question with two answers — give it now, or "Give it later", which prints it as owed — and
 * the receipt waits on whichever comes. There is no undo for change given, so giving it stays a
 * deliberate tap on the amount, not one of the method buttons.
 */
export function ChangeOwed({
  storeId,
  saleId,
  owed,
  atSale,
  onGiven,
  later = false,
  onLater,
  onBusy,
}: {
  storeId: string;
  saleId: string;
  /** Still owed on this receipt. The block is not drawn at nothing. */
  owed: number;
  atSale: boolean;
  onGiven: () => void;
  /** Answered "later": said in one line, with a way to give it after all. */
  later?: boolean;
  /** Offered at the counter: the change stays owed and the paper can go. */
  onLater?: () => void;
  /** A give is under way — the paper waits for it. */
  onBusy?: (busy: boolean) => void;
}) {
  const problem = useProblem();
  const [method, setMethod] = useState<Method>('cash');
  const [busy, setBusy] = useState(false);
  const [reopened, setReopened] = useState(false);
  const accounts = useBankAccounts(storeId);
  const busyRef = useRef(onBusy);
  busyRef.current = onBusy;
  useEffect(() => {
    busyRef.current?.(busy);
  }, [busy]);

  if (!(owed > 0.005)) return null;

  const give = async () => {
    setBusy(true);
    try {
      const { error } = await getSupabase().rpc('give_sale_change', {
        p_sale_id: saleId,
        p_amount: owed,
        p_method: method,
        p_bank_account_id: method === 'transfer' ? (accounts.find((a) => a.is_default)?.id ?? null) : null,
        p_at_sale: atSale,
      });
      if (error) throw error;
      accountsChanged();
      onGiven();
    } catch (e) {
      problem.show(messageOf(e, 'The change could not be recorded.'));
    } finally {
      setBusy(false);
    }
  };

  if (later && !reopened) {
    return (
      <section className={`${styles.block} ${styles.answered}`} aria-label="Change you owe them">
        <p className={styles.laterLine}>
          <span>
            ✓ {formatMoney(owed)} change stays owed to them — it prints on the receipt.
          </span>
          <button type="button" className={styles.link} onClick={() => setReopened(true)}>
            Give it now
          </button>
        </p>
      </section>
    );
  }

  return (
    <section className={styles.block} aria-label="Change you owe them">
      <ProblemDialog problem={problem} title="Not recorded" />
      <h2 className={styles.head}>You owe them {formatMoney(owed)} change</h2>
      <div className={styles.methods} role="group" aria-label="Change given by">
        {(['cash', 'transfer', 'pos'] as Method[]).map((m) => (
          <button
            key={m}
            type="button"
            className={`${styles.method} ${method === m ? styles.methodActive : ''}`}
            aria-pressed={method === m}
            onClick={() => setMethod(m)}
          >
            {m === 'cash' ? 'Cash' : m === 'transfer' ? 'Transfer' : 'POS'}
          </button>
        ))}
      </div>
      <div className={styles.actions}>
        <Button busy={busy} busyLabel="Recording" onClick={() => void give()}>
          Give the {formatMoney(owed)} now
        </Button>
        {onLater && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setReopened(false);
              onLater();
            }}
          >
            Give it later
          </Button>
        )}
      </div>
      {!onLater && (
        <p className={styles.note}>It prints on the receipt as change owed to them. Give it now if you have it.</p>
      )}
    </section>
  );
}
