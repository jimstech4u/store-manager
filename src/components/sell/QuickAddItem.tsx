'use client';

import { useEffect, useState } from 'react';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { quickAddSellable } from '@/lib/stacks/mid-sale';
import styles from './QuickAddItem.module.css';

/**
 * Something the shop sells and has never entered, added without leaving the receipt.
 *
 * THREE QUESTIONS, because there is a customer waiting. What is it called, what is it sold in,
 * what does it cost. That is the least that makes a thing sellable, and everything else — what it
 * is bought in, how a crate relates to a bottle, a cheaper price for buying five — belongs on the
 * item's own screen, filled in by somebody who is not standing at a counter.
 *
 * WHOEVER MAY SELL MAY ADD. What they cannot do is vouch for it: added by a seller it lands in the
 * review queue for a manager to check, while the sale it was created for goes straight through.
 * The alternative — refusing until somebody with the right permission is found — is how a sale
 * ends up written on paper, which loses the sale AND the record.
 *
 * USED WHEREVER AN ITEM IS THE THING BEING BLOCKED ON — a receipt, a delivery being written up,
 * a shelf being counted. `purpose` only changes the words; what it creates is the same in all
 * three, because the shop is describing the same object. Somebody counting a shelf and finding
 * something the catalogue has never heard of has exactly the sell screen's problem: leave the
 * count to go and file it, and come back to a count half done.
 *
 * A SHEET, NOT A PAGE, and deliberately against the usual rule. A form is a page here because a
 * page survives a rotation and gets a back button; but this form exists to be answered in fifteen
 * seconds without losing sight of the receipt it is for, and pushing a page over a half-built
 * order is the thing sellers already complain about.
 */
const PURPOSE = {
  sale: {
    title: 'Add it and carry on',
    confirm: 'Add to this sale',
    priceHint: 'You can still change it on this receipt.',
    lands: 'This goes on the sale now.',
  },
  delivery: {
    title: 'Add it and carry on',
    confirm: 'Add to this delivery',
    priceHint: 'What you SELL it for. What you paid is the next question, on the delivery itself.',
    lands: 'This goes on the delivery now.',
  },
  count: {
    title: 'Add it and count it',
    confirm: 'Add and count it',
    priceHint: 'You can change it later on the item.',
    lands: 'This goes into your stock list now, ready to count.',
  },
} as const;

export function QuickAddItem({
  open,
  onClose,
  storeId,
  initialName = '',
  onAdded,
  purpose = 'sale',
}: {
  open: boolean;
  onClose: () => void;
  storeId: string;
  /** Prefilled from whatever was typed into the picker that found nothing. */
  initialName?: string;
  /** Handed the new item's id, so the receipt can put it on immediately. */
  onAdded: (productId: string, name: string) => void;
  /** What the shop is in the middle of. Changes the wording only. */
  purpose?: 'sale' | 'delivery' | 'count';
}) {
  const words = PURPOSE[purpose];
  const [name, setName] = useState(initialName);
  const [unit, setUnit] = useState('');
  const [plural, setPlural] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setUnit('');
      setPlural('');
      setPrice('');
      setProblem(null);
    }
  }, [open, initialName]);

  const ready = name.trim() !== '' && unit.trim() !== '';

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const id = await quickAddSellable(storeId, name, unit, plural, price);
      onAdded(id, name.trim());
      onClose();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That could not be added.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={words.title}
      footer={
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button busy={busy} disabled={!ready} onClick={() => void save()}>
            {words.confirm}
          </Button>
        </div>
      }
    >
      {problem && (
        <InfoPanel tone="danger" title="Not added">
          {problem}
        </InfoPanel>
      )}

      <Field
        label="What is it called?"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Peak Milk 400g"
        autoFocus
      />

      <Field
        label="What are you selling it in?"
        value={unit}
        onChange={(e) => setUnit(e.target.value)}
        placeholder="Tin, Sachet, Carton"
        hint="One of them. The shop keeps the word for next time."
      />

      <Field
        label="And more than one?"
        optional
        value={plural}
        onChange={(e) => setPlural(e.target.value)}
        placeholder={unit.trim() ? `${unit.trim()}s` : 'Tins'}
        hint="What gets printed on a receipt."
      />

      <Field
        label={`Price for one ${unit.trim().toLowerCase() || 'of them'}`}
        optional
        numeric
        prefix="₦"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        placeholder="0"
        hint={words.priceHint}
      />

      <InfoPanel tone="info" title="Somebody will check it">
        {words.lands} Unless you can sign off records yourself, a manager sees it under
        <strong> Waiting to be checked</strong> and fills in the rest — what it arrives in, what it
        cost, a cheaper price for buying more.
      </InfoPanel>
    </BottomSheet>
  );
}
