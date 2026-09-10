'use client';

import { useCallback, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import {
  recordStaffCharge,
  staffChargeLedger,
  staffChargesOwed,
  type StaffChargeDirection,
  type StaffChargeRow,
  type StaffOwing,
} from '@/lib/stacks/staff-charges';
import { formatMoney, messageOf } from '@/lib/format';
import styles from './staff-charges-page.module.css';

const KINDS: { code: StaffChargeDirection; label: string; blurb: string }[] = [
  { code: 'charged', label: 'Charge them', blurb: 'Stock or cash that went missing on their watch.' },
  { code: 'paid', label: 'They paid', blurb: 'Handed over, or taken out of wages.' },
  { code: 'written_off', label: 'Write it off', blurb: 'The shop has decided not to pursue it.' },
];

/**
 * What staff owe the shop, and what they have paid back.
 *
 * Written by a count that found stock missing and blamed somebody, and reachable here so it can be
 * settled. It is NOT a customer balance and it is NEVER counted as takings: money recovered for
 * stolen stock is not a sale, and if it were netted into takings a shop's income would climb every
 * time something went missing.
 *
 * THE PERSON NAMED CAN READ THEIR OWN. A charge against somebody they cannot see is not a record,
 * it is a rumour — so the row-level policy admits both a manager and the person it is about.
 */
export default function StaffChargesPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();
  const problem = useProblem();
  const showProblem = problem.show;

  const read = useCallback(() => staffChargesOwed(store!.id), [store]);
  const area = useLoadArea<StaffOwing[]>(read, [store?.id ?? ''], {
    onFail: showProblem,
    whenNot: !store,
  });

  /** Whose trace is open, and what is being added to it. */
  const [open, setOpen] = useState<string | null>(null);
  const [ledger, setLedger] = useState<StaffChargeRow[]>([]);
  const [kind, setKind] = useState<StaffChargeDirection>('paid');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [state, setState] = useState<AsyncState>('idle');
  const [failure, setFailure] = useState<string | null>(null);

  useLiveRefresh(nav, area.reload);

  if (!store) return null;

  const openTrace = async (row: StaffOwing) => {
    if (open === row.memberUserId) {
      setOpen(null);
      return;
    }
    setOpen(row.memberUserId);
    setAmount('');
    setReason('');
    setKind('paid');
    try {
      setLedger(await staffChargeLedger(store.id, row.memberUserId));
    } catch (e) {
      showProblem(messageOf(e, 'Could not read that history.'));
    }
  };

  const add = async (row: StaffOwing) => {
    setState('busy');
    setFailure(null);
    try {
      await recordStaffCharge({
        storeId: store.id,
        memberUserId: row.memberUserId,
        amount: Number(amount),
        direction: kind,
        reason: reason.trim(),
      });
      setAmount('');
      setReason('');
      setLedger(await staffChargeLedger(store.id, row.memberUserId));
      area.reload();
      setState('idle');
    } catch (e) {
      setState('failed');
      setFailure(messageOf(e, 'Could not record that.'));
    }
  };

  const said = (d: StaffChargeDirection) =>
    d === 'charged' ? 'Charged' : d === 'paid' ? 'Paid back' : 'Written off';

  return (
    <PageScaffold onBack={goBack} title="What staff owe" subtitle="Missing stock and short tills">
      <ProblemDialog problem={problem} title="Could not read this" />

      <InfoPanel id="staff.charges" tone="info" title="This is not a customer account">
        Money recovered for stock that went missing is not a sale, so it never appears in your
        takings. It sits here until it is paid back or written off, and the person it is about can
        see their own.
      </InfoPanel>

      <LoadArea area={area} what="what staff owe">
        {(rows) =>
          rows.length === 0 ? (
            <p className={styles.none}>
              Nobody has been charged for anything. When a count finds stock missing you can put it
              on somebody there, and it will show up here.
            </p>
          ) : (
            <ul className={styles.rows}>
              {rows.map((r) => (
                <li key={r.memberUserId} className={styles.row}>
                  <span className={styles.who}>
                    <button
                      type="button"
                      className={styles.who}
                      onClick={() => void openTrace(r)}
                      aria-expanded={open === r.memberUserId}
                    >
                      {r.fullName}
                    </button>
                    <span className={styles.detail}>
                      {formatMoney(r.charged)} charged
                      {r.paid > 0 && `, ${formatMoney(r.paid)} paid back`}
                      {r.writtenOff > 0 && `, ${formatMoney(r.writtenOff)} written off`}
                    </span>

                    {open === r.memberUserId && (
                      <>
                        {can('staff.charge') && (
                          <div className={styles.composer}>
                            {/*
                              ONE COMPOSER, not a row of boxes per possible kind — the pattern the
                              fees, charges and payments screens all use. Pick what happened, say
                              how much and why, and press the green Add.
                            */}
                            <div className={styles.kinds}>
                              {KINDS.map((k) => (
                                <button
                                  key={k.code}
                                  type="button"
                                  className={`${styles.kind} ${kind === k.code ? styles.kindOn : ''}`}
                                  onClick={() => setKind(k.code)}
                                >
                                  {k.label}
                                </button>
                              ))}
                            </div>
                            <p className={styles.detail}>
                              {KINDS.find((k) => k.code === kind)?.blurb}
                            </p>

                            <Field
                              label="How much"
                              numeric
                              prefix="₦"
                              value={amount}
                              onChange={(e) => setAmount(e.target.value)}
                              placeholder="0"
                            />
                            <Field
                              label="What for"
                              value={reason}
                              onChange={(e) => setReason(e.target.value)}
                              placeholder="Nine crates missing after the Friday count"
                              hint="Never optional. A charge against a person with no reason on it cannot be answered."
                            />

                            {/* Green is what ADDS — the one shape learnt once, everywhere. */}
                            <AsyncAction state={state} problem={failure} label="Recording this">
                              <Button
                                onClick={() => void add(r)}
                                disabled={Number(amount) <= 0 || reason.trim() === ''}
                                fullWidth
                              >
                                Add it
                              </Button>
                            </AsyncAction>
                          </div>
                        )}

                        <h3 className={styles.section}>Everything so far</h3>
                        {ledger.length === 0 ? (
                          <p className={styles.none}>Nothing recorded yet.</p>
                        ) : (
                          <ul className={styles.ledger}>
                            {ledger.map((e) => (
                              <li key={e.id} className={styles.entry}>
                                <span>
                                  {said(e.direction)} — {e.reason}
                                </span>
                                <span>
                                  {formatMoney(e.amount)} ·{' '}
                                  {new Date(e.occurredAt).toLocaleDateString()}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </span>

                  <span className={styles.figure}>
                    {r.owing > 0 ? (
                      formatMoney(r.owing)
                    ) : (
                      <span className={styles.settled}>settled</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </LoadArea>
    </PageScaffold>
  );
}
