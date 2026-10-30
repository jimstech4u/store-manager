'use client';

import { useMemo, useState } from 'react';
import { useLocation } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Field } from '@/components/ui/Field';
import { DocumentActions } from '@/components/ui/DocumentActions';
import { PrintPreview } from '@/components/settings/PrintPreview';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useResource } from '@/lib/stacks/resource';
import { ACCOUNT_DERIVED_SCOPE } from '@/lib/stacks/customer-account';
import { usePrintSettings } from '@/lib/stacks/print-settings';
import { useThisPrinter } from '@/lib/stacks/printer';
import { getSupabase } from '@/lib/supabase/client';
import { receiptLines } from '@/lib/escpos-text';
import { formatDate, formatMoney } from '@/lib/format';
import { KINDS, statementDocument, type Kind, type Statement } from '@/lib/statement-document';
import styles from './account-statement-page.module.css';

/**
 * A CUSTOMER'S STATEMENT — for a period, of the things chosen, on paper or sent.
 *
 * "Print a detailed account statement to the printer or share it like a receipt, PDF and more —
 * payments in, sales, items and all of that — and select what we want, filter, and a range of
 * dates." Reached from the account's header.
 *
 * One read (`customer_statement_detail`, 0255) for the period: what they owed as it began, every
 * move inside it, the items on each sale, what they owed as it ended and what was still with them.
 * The ticks decide what goes on the paper; the figures at either end are always the account's own,
 * so leaving payments off never makes the closing balance look different from the truth.
 */

type PeriodKind = 'month' | 'last_month' | 'days30' | 'all' | 'custom';
const PERIODS: { kind: PeriodKind; label: string }[] = [
  { kind: 'month', label: 'This month' },
  { kind: 'last_month', label: 'Last month' },
  { kind: 'days30', label: 'Last 30 days' },
  { kind: 'all', label: 'All time' },
  { kind: 'custom', label: 'Pick dates' },
];

function periodOf(kind: PeriodKind, fromText: string, toText: string) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  switch (kind) {
    case 'month': {
      const from = new Date(midnight.getFullYear(), midnight.getMonth(), 1);
      return { from, to: null as Date | null, label: `${formatDate(from)} – ${formatDate(midnight)}` };
    }
    case 'last_month': {
      const from = new Date(midnight.getFullYear(), midnight.getMonth() - 1, 1);
      const to = new Date(midnight.getFullYear(), midnight.getMonth(), 1);
      return { from, to, label: from.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
    }
    case 'days30': {
      const from = new Date(midnight.getTime() - 29 * 86400000);
      return { from, to: null, label: `${formatDate(from)} – ${formatDate(midnight)}` };
    }
    case 'all':
      return { from: null, to: null, label: 'All time' };
    default: {
      const from = fromText ? new Date(`${fromText}T00:00:00`) : null;
      const toDay = toText ? new Date(`${toText}T00:00:00`) : null;
      const to = toDay ? new Date(toDay.getTime() + 86400000) : null;
      const label =
        from && toDay
          ? `${formatDate(from)} – ${formatDate(toDay)}`
          : from
            ? `From ${formatDate(from)}`
            : toDay
              ? `Up to ${formatDate(toDay)}`
              : 'All time';
      return { from, to, label };
    }
  }
}

export default function AccountStatementPage() {
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const customerId = (location?.params?.id as string | undefined) ?? null;

  const [periodKind, setPeriodKind] = useState<PeriodKind>('month');
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  const [on, setOn] = useState<Set<Kind>>(new Set(['sales', 'items', 'payments', 'charges']));
  const period = useMemo(() => periodOf(periodKind, fromText, toText), [periodKind, fromText, toText]);
  const fromIso = period.from?.toISOString() ?? null;
  const toIso = period.to?.toISOString() ?? null;

  const statement = useResource<Statement>({
    key: `statement:${customerId ?? 'none'}:${fromIso ?? 'start'}:${toIso ?? 'now'}`,
    scope: ACCOUNT_DERIVED_SCOPE,
    enabled: Boolean(customerId),
    deps: [customerId ?? '', fromIso ?? '', toIso ?? ''],
    read: async () => {
      const { data, error } = await getSupabase().rpc('customer_statement_detail', {
        p_store_customer_id: customerId,
        p_from: fromIso,
        p_to: toIso,
      });
      if (error) throw error;
      if (!data) throw new Error('This customer could not be found.');
      const d = data as Record<string, unknown>;
      return { ...(d as unknown as Statement), opening: Number(d.opening) || 0, closing: Number(d.closing) || 0 };
    },
  });

  const settings = usePrintSettings(store?.id ?? null);
  const width = settings.data?.width ?? 80;
  const printer = useThisPrinter(store?.id ?? null, width);

  if (!store) return null;
  const st = statement.data ?? null;

  const status: PageStatus = !customerId
    ? { state: 'empty', title: 'Open a customer first', body: 'A statement is reached from their account.' }
    : st
      ? { state: 'ready' }
      : statement.error
        ? { state: 'error', what: 'their statement', error: String(statement.error), onRetry: statement.reload }
        : { state: 'loading', what: 'their statement' };

  const toggle = (k: Kind) => {
    const next = new Set(on);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setOn(next);
  };

  const doc = st
    ? statementDocument(st, { shopName: store.name, periodLabel: period.label, hasStart: Boolean(period.from), on })
    : null;

  const name = st?.customer?.name ?? 'Customer';

  return (
    <PageScaffold onBack={goBack} title="Statement" subtitle={st?.customer?.name ?? 'Their account'}>
      <div className={styles.chips} role="tablist" aria-label="Which period">
        {PERIODS.map((p) => (
          <button
            key={p.kind}
            type="button"
            role="tab"
            aria-selected={periodKind === p.kind}
            className={`${styles.chip} ${periodKind === p.kind ? styles.chipOn : ''}`}
            onClick={() => setPeriodKind(p.kind)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {periodKind === 'custom' && (
        <div className={styles.dates}>
          <Field label="From" type="date" value={fromText} onChange={(e) => setFromText(e.target.value)} />
          <Field label="To" type="date" value={toText} onChange={(e) => setToText(e.target.value)} />
        </div>
      )}

      <fieldset className={styles.kinds}>
        <legend className={styles.legend}>On the statement</legend>
        {KINDS.map((k) => (
          <label key={k.kind} className={styles.check}>
            <input
              type="checkbox"
              checked={on.has(k.kind)}
              disabled={k.kind === 'items' && !on.has('sales')}
              onChange={() => toggle(k.kind)}
            />
            <span>{k.label}</span>
          </label>
        ))}
      </fieldset>

      <PageState status={status}>
        {() =>
          doc && (
            <>
              <div className={styles.paper} data-print-root style={{ ['--receipt-width' as string]: `${width}mm` }}>
                <PrintPreview lines={receiptLines(doc, printer.layout)} layout={printer.layout} />
              </div>
              <DocumentActions
                storeId={store.id}
                doc={doc}
                filename={`statement-${name.toLowerCase().replace(/\s+/g, '-')}`}
                title={`Statement for ${name}`}
                message={`${name}, your statement from ${store.name} (${period.label}): ${
                  st && st.closing < -0.005 ? 'we owe you' : 'owed'
                } ${formatMoney(Math.abs(st?.closing ?? 0))}.`}
                whatsapp={{ phone: st?.customer?.phone, customerId: st?.customer?.id, customerName: name }}
              />
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
