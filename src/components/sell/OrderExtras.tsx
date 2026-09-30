"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { CloseIcon, PlusIcon } from "@/components/ui/Icon";
import type { DraftCharge, DraftDeposit } from "@/lib/stacks/draft-orders";
import { formatMoney } from "@/lib/format";
import styles from "./OrderExtras.module.css";

/**
 * THE CHARGES AND THE DEPOSIT ON AN OPEN ORDER — one form each, wherever the order is worked on.
 *
 * Take payment composes them, and All items (the order read back to a customer before they pay)
 * lets the same be added there, so the list the customer agrees to is the bill they are asked for
 * and nothing has to be corrected afterwards. Both write the ORDER's own `charges` / `deposits`,
 * the rows Take payment settles.
 *
 * `listed` shows what is already on the order, each with its cross — Take payment lists them with
 * the goods instead, so it leaves this off. `onCancel` puts a Cancel beside Add, for a page where
 * the form is opened on purpose and closed again; `collapsed` then shows only what was added, with
 * "Add another" (`onExpand`) to open the form again.
 */

const newKey = () => Math.random().toString(36).slice(2, 10);

export function ChargesEditor({
  charges,
  onChange,
  listed = false,
  onCancel,
  collapsed = false,
  onExpand,
}: {
  charges: DraftCharge[];
  onChange: (next: DraftCharge[]) => void;
  listed?: boolean;
  onCancel?: () => void;
  collapsed?: boolean;
  onExpand?: () => void;
}) {
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  return (
    <section className={styles.box}>
      <span className={styles.label}>
        {listed ? "Charges" : "Add a charge"}
      </span>

      {listed &&
        charges.map((c) => (
          <div className={styles.row} key={c.key}>
            <button
              type="button"
              className={styles.remove}
              onClick={() => onChange(charges.filter((x) => x.key !== c.key))}
              aria-label={`Remove ${c.label.trim() || "this charge"}`}
            >
              <CloseIcon />
            </button>
            <span className={styles.body}>
              <span className={styles.name}>{c.label.trim() || "Charge"}</span>
              {c.note ? <span className={styles.note}>{c.note}</span> : null}
            </span>
            <span className={styles.amount}>
              {formatMoney(Number(c.amount) || 0)}
            </span>
          </div>
        ))}

      {collapsed ? (
        <Button fullWidth variant="secondary" onClick={onExpand}>
          <PlusIcon /> Add another charge
        </Button>
      ) : (
        <>
          <div className={styles.pair}>
            <Field
              label="What for"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Transport"
            />
            <Field
              label="Amount"
              numeric
              prefix="₦"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
            />
          </div>

          <Field
            label="Note"
            optional
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything to remember about this charge"
          />

          <div className={styles.buttons}>
            <Button
              fullWidth
              disabled={!label.trim() || !(Number(amount) > 0)}
              onClick={() => {
                onChange([
                  ...charges,
                  {
                    key: newKey(),
                    label: label.trim(),
                    amount,
                    note: note.trim(),
                  },
                ]);
                // Cleared, ready for the next one — two charges in a row is the common case.
                setLabel("");
                setAmount("");
                setNote("");
              }}
            >
              <PlusIcon /> Add charge
            </Button>
            {onCancel && (
              <Button fullWidth variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function DepositEditor({
  deposits,
  onChange,
  alreadyHeld = 0,
  listed = false,
  onCancel,
  collapsed = false,
  onExpand,
}: {
  deposits: DraftDeposit[];
  onChange: (next: DraftDeposit[]) => void;
  /** What the shop already holds for this customer — the two add up, so it is said. */
  alreadyHeld?: number;
  listed?: boolean;
  onCancel?: () => void;
  collapsed?: boolean;
  onExpand?: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  return (
    <section className={styles.deposit}>
      <span className={styles.label}>Take a deposit</span>
      <p className={styles.why}>
        Money of theirs you will be holding. Not a payment — it comes back, or
        you keep it and say why.
        {alreadyHeld > 0 && (
          <> You are already holding {formatMoney(alreadyHeld)} for them.</>
        )}
      </p>

      {listed &&
        deposits.map((d) => (
          <div className={styles.row} key={d.key}>
            <button
              type="button"
              className={styles.remove}
              onClick={() => onChange(deposits.filter((x) => x.key !== d.key))}
              aria-label="Remove this deposit"
            >
              <CloseIcon />
            </button>
            <span className={styles.body}>
              <span className={styles.name}>Deposit</span>
              {d.note ? <span className={styles.note}>{d.note}</span> : null}
            </span>
            <span className={styles.amount}>
              {formatMoney(Number(d.amount) || 0)}
            </span>
          </div>
        ))}

      {collapsed ? (
        <Button fullWidth variant="secondary" onClick={onExpand}>
          <PlusIcon /> Add another deposit
        </Button>
      ) : (
        <>
          <div className={styles.pair}>
            <Field
              label="Amount"
              numeric
              prefix="₦"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
            />
            <Field
              label="What for"
              optional
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Crates and bottles"
            />
          </div>

          <div className={styles.buttons}>
            <Button
              fullWidth
              disabled={!(Number(amount) > 0)}
              onClick={() => {
                onChange([
                  ...deposits,
                  { key: newKey(), amount, note: note.trim() },
                ]);
                setAmount("");
                setNote("");
              }}
            >
              <PlusIcon /> Add deposit
            </Button>
            {onCancel && (
              <Button fullWidth variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
