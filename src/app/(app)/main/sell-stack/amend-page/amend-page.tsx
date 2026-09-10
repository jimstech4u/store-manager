'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { CustomerPicker } from '@/components/customers/CustomerPicker';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import {
  amendSale,
  saleDocument,
  saleRevisions,
  type Revision,
  type SaleDocument,
} from '@/lib/stacks/amend';
import { formatMoney, messageOf } from '@/lib/format';
import styles from './amend-page.module.css';

interface Editable {
  key: string;
  productId: string;
  productName: string;
  saleUnitId: string | null;
  unitName: string | null;
  perUnitBase: number;
  qty: string;
  price: string;
  wasQty: number;
  wasPrice: number;
  containersOut: number;
  dropped: boolean;
}

/**
 * Correcting a receipt that has already been settled.
 *
 * NOT a void and a re-key. The customer is holding a printed copy with this number on it and a
 * tracking link that has to keep resolving — voiding loses both, loses the payment allocation, and
 * makes two documents out of one sale. The receipt keeps its id and gains a revision.
 *
 * WHAT IS EDITABLE IS DELIBERATELY NARROW: how many, and at what price. Adding a line that was
 * never on the receipt is a different sale, and the till is where a sale is built. Somebody
 * correcting a receipt is almost always fixing a quantity or a price they keyed wrong.
 */
export default function AmendPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const problem = useProblem();
  const showProblem = problem.show;

  const saleId = (location?.params?.id as string | undefined) ?? null;

  const read = useCallback(async () => {
    const [doc, revs] = await Promise.all([saleDocument(saleId!), saleRevisions(saleId!)]);
    return { doc, revs };
  }, [saleId]);

  const area = useLoadArea<{ doc: SaleDocument | null; revs: Revision[] }>(read, [saleId ?? ''], {
    onFail: showProblem,
    whenNot: !saleId,
  });

  const [lines, setLines] = useState<Editable[]>([]);
  const [reason, setReason] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [state, setState] = useState<AsyncState>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [seeded, setSeeded] = useState<string | null>(null);

  /*
   * SEEDED ONCE, from the document — and never re-seeded while it is being edited.
   *
   * `useLoadArea` keeps its cached value and refreshes on resume, so an effect that copied the
   * document into local state on every change would throw away what somebody had typed the moment
   * the page came back from a customer picker. Keyed on the sale id, so a genuinely different
   * receipt does seed.
   */
  useEffect(() => {
    const doc = area.data?.doc;
    if (!doc || seeded === doc.saleId) return;
    setSeeded(doc.saleId);
    setCustomerId(doc.customer?.id ?? null);
    setCustomerName(doc.customer?.name ?? null);
    setLines(
      doc.lines.map((l, i) => ({
        key: `${l.productId}-${l.saleUnitId ?? 'base'}-${i}`,
        productId: l.productId,
        productName: l.productName,
        saleUnitId: l.saleUnitId,
        unitName: l.unitName,
        perUnitBase: l.enteredQty > 0 ? l.baseQty / l.enteredQty : 1,
        qty: String(l.enteredQty),
        price: String(l.unitPrice),
        wasQty: l.enteredQty,
        wasPrice: l.unitPrice,
        containersOut: l.containersOut,
        dropped: false,
      })),
    );
  }, [area.data, seeded]);

  /*
   * THE PICKER OPENS ON THIS PAGE, rather than pushing one.
   *
   * Popping a pushed page destroys what was typed on it — choosing a customer from Take payment
   * once popped back to the till and discarded the charge and note already entered. Everything on
   * this form (the quantities, the price, the reason) would go the same way.
   */
  const [picking, setPicking] = useState(false);

  /*
   * A customer created from the picker comes straight back onto this correction.
   *
   * Published under its OWN name with the intent stated in the push, so nothing else can pick it
   * up: `onCustomerCreated` is session-wide and never withdrawn, which is how somebody filed from
   * the People tab once attached themselves to whatever sale was open.
   */
  useEffect(() => {
    const cleanup = nav.provideObject(
      'onCustomerForAmend',
      () => (customer: { id: string; name: string }) => {
        setCustomerId(customer.id);
        setCustomerName(customer.name);
      },
      { global: true, scope: 'people' },
    );
    return cleanup;
  }, [nav]);

  const live = lines.filter((l) => !l.dropped);

  const total = useMemo(
    () => live.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.price) || 0), 0),
    [live],
  );

  const changed = useMemo(
    () =>
      lines.some(
        (l) =>
          l.dropped ||
          Number(l.qty) !== l.wasQty ||
          Number(l.price) !== l.wasPrice,
      ) || (customerId ?? null) !== (area.data?.doc?.customer?.id ?? null),
    [lines, customerId, area.data],
  );

  if (!store) return null;

  const patch = (key: string, next: Partial<Editable>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...next } : l)));

  const save = async () => {
    setState('busy');
    setFailure(null);
    try {
      const result = await amendSale({
        saleId: saleId!,
        reason: reason.trim(),
        lines: live.map((l) => ({
          productId: l.productId,
          saleUnitId: l.saleUnitId,
          enteredQty: Number(l.qty) || 0,
          baseQty: (Number(l.qty) || 0) * l.perUnitBase,
          unitPrice: Number(l.price) || 0,
          lineTotal: (Number(l.qty) || 0) * (Number(l.price) || 0),
          containersOut: l.containersOut > 0 ? Number(l.qty) || 0 : 0,
        })),
        customerId,
      });
      setState('idle');
      void nav.replace('receipt_page', { id: result.saleId });
    } catch (e) {
      setState('failed');
      setFailure(messageOf(e, 'Could not correct that receipt.'));
    }
  };

  return (
    <PageScaffold onBack={goBack} title="Correct this receipt" subtitle="What it should have said">
      <ProblemDialog problem={problem} title="Could not read this receipt" />

      <LoadArea area={area} what="this receipt">
        {(data) =>
          !data.doc ? (
            <InfoPanel tone="info" title="No receipt chosen">
              Corrections are reached from a receipt.
            </InfoPanel>
          ) : data.doc.status !== 'posted' ? (
            <InfoPanel tone="warning" title={`This receipt is ${data.doc.status}`}>
              There is nothing to correct on a receipt that has already been cancelled.
            </InfoPanel>
          ) : (
            <>
              <Explain label="What happens to the old copy?">
                The receipt keeps its number, so the link you sent the customer still works. What it
                said before is kept in full and shown below, and the new printed copy says it
                replaces the old one — because somebody may still be holding that.
              </Explain>

              {data.doc.revision > 1 && (
                <InfoPanel tone="info" title={`This is already revision ${data.doc.revision}`}>
                  It has been corrected before. Everything it has said is kept.
                </InfoPanel>
              )}

              <div className={styles.lines}>
                {lines.map((l) => (
                  <div key={l.key} className={styles.line}>
                    <div className={styles.lineHead}>
                      <span className={styles.lineName}>
                        {l.productName}
                        {l.unitName ? ` · ${l.unitName.toLowerCase()}` : ''}
                      </span>
                      <span className={styles.lineWas}>
                        was {l.wasQty} at {formatMoney(l.wasPrice)}
                      </span>
                    </div>

                    {l.dropped ? (
                      <button
                        type="button"
                        className={styles.drop}
                        onClick={() => patch(l.key, { dropped: false })}
                      >
                        Put this line back
                      </button>
                    ) : (
                      <>
                        <div className={styles.boxes}>
                          <Field
                            label="How many"
                            numeric
                            value={l.qty}
                            onChange={(e) => patch(l.key, { qty: e.target.value })}
                          />
                          <Field
                            label="Each"
                            numeric
                            prefix="₦"
                            value={l.price}
                            onChange={(e) => patch(l.key, { price: e.target.value })}
                          />
                        </div>
                        <button
                          type="button"
                          className={styles.drop}
                          onClick={() => patch(l.key, { dropped: true })}
                        >
                          This was never on the receipt
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>

              <div className={styles.totals}>
                <div className={styles.totalRow}>
                  <span>It said</span>
                  <span>{formatMoney(data.doc.total)}</span>
                </div>
                <div className={styles.totalRow}>
                  <strong>It should say</strong>
                  <strong>{formatMoney(total + data.doc.feeAmount)}</strong>
                </div>
              </div>

              {/*
                A WALK-IN NEEDS SOMEBODY, once the correction leaves anything owing.

                The server refuses it outright — there would be nobody to chase for the money and
                nobody to settle the crates with. Said here BEFORE the button, as a condition rather
                than a failure, so it can be fixed without being dismissed first.
              */}
              {!customerId && (
                <>
                  <InfoPanel tone="warning" title="Nobody is named on this receipt">
                    It was sold over the counter. If your correction leaves money owing or
                    containers out, there has to be somebody to owe it.
                  </InfoPanel>
                  <Button variant="secondary" fullWidth onClick={() => setPicking(true)}>
                    Add a customer to it
                  </Button>
                </>
              )}

              {customerId && customerName && (
                <InfoPanel tone="info" title={`On ${customerName}'s account`}>
                  What is left owing, and any containers, go to them.
                </InfoPanel>
              )}

              <Field
                label="Why is it being corrected?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Keyed three crates, only two went"
                hint="Asked weeks later by somebody who was not there. This is the part that settles it."
              />

              {/* The action ENDS the page rather than being pinned to its foot — see CLAUDE.md. */}
              <div className={styles.actions}>
                <AsyncAction state={state} problem={failure} label="Correcting this receipt">
                  <Button
                    onClick={() => void save()}
                    disabled={!changed || reason.trim() === '' || live.length === 0}
                    fullWidth
                  >
                    {changed ? 'Correct it' : 'Nothing changed yet'}
                  </Button>
                </AsyncAction>
              </div>

              {data.revs.length > 0 && (
                <>
                  <h2 className={styles.section}>What it used to say</h2>
                  <ul className={styles.history}>
                    {data.revs.map((r) => (
                      <li key={r.revision} className={styles.was}>
                        <div className={styles.wasHead}>
                          Revision {r.revision} — {formatMoney(r.document.total)}
                        </div>
                        <div className={styles.wasDetail}>
                          {r.document.lines
                            .map((l) => `${l.enteredQty} × ${l.productName}`)
                            .join(', ')}
                        </div>
                        <div className={styles.wasDetail}>
                          {r.reason} · {new Date(r.amendedAt).toLocaleString()}
                          {r.actorName ? ` · ${r.actorName}` : ''}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )
        }
      </LoadArea>

      <CustomerPicker
        open={picking}
        onClose={() => setPicking(false)}
        storeId={store.id}
        onPick={(customer) => {
          setCustomerId(customer.id);
          setCustomerName(customer.name);
          setPicking(false);
        }}
        /*
         * Creating one is still a page, and still pushed from HERE — so popping the form lands
         * back on this correction with everything typed on it intact.
         *
         * The intent is stated in the push. A callback published once is found by everyone: the
         * sell screen publishes `onCustomerCreated` session-wide and never withdraws it, which is
         * how a customer created from the People tab once attached itself to whatever sale
         * happened to be open.
         */
        onCreate={(name) => {
          setPicking(false);
          void nav.push('customer_form_page', {
            ...(name.trim() ? { name } : {}),
            then: 'attach-to-amend',
            required: 'minimum',
          });
        }}
      />
    </PageScaffold>
  );
}
