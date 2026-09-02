'use client';

import { useLocation } from '@academix-admin/navigation-stack';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { InfoPanel } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { Receipt } from '../sell-page/Receipt';
import { ReturnIcon } from '@/components/ui/Icon';

/**
 * A receipt, as a page in the stack rather than a sheet.
 *
 * It was a sheet held in the sell page's state, and it never appeared: settling closes the
 * customer's tab, which empties the order list, which starts a fresh order — and somewhere in
 * that churn the page remounted and the transient `settledSale` went with it. The sale was
 * recorded correctly every time and the customer simply never saw their receipt.
 *
 * A page fixes that by not being transient. The sale id lives in the navigation params, so the
 * receipt survives a remount, gets a back button for free, can be linked to, and — the reason it
 * had to exist regardless — is reachable again later, because "print that receipt again" is an
 * ordinary request and there was no way to answer it.
 */
export default function ReceiptPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const saleId = (location?.params?.id as string | undefined) ?? null;
  const fresh = location?.params?.fresh === '1';

  if (!store) return null;

  if (!saleId) {
    return (
      <PageScaffold onBack={goBack} title="No receipt chosen">
        <InfoPanel tone="info" title="Open a sale to see its receipt">
          Receipts are reached from a sale, or from the money screen.
        </InfoPanel>
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      onBack={goBack}
      title={fresh ? 'Sale recorded' : 'Receipt'}
      subtitle={store.name}
      /*
        THE SECOND WAY INTO THE EMPTIES LIST, and the more natural one.

        Somebody reading back a sale is often reading it BECAUSE of the crates — "what went out on
        this one, and has any of it come back?" The receipt already prints what is expected; this
        is the way to act on it without hunting for the till's own action.
      */
      actions={[
        {
          key: 'empties',
          icon: <ReturnIcon />,
          onClick: () => void nav.push('empties_page'),
          ariaLabel: 'Containers still to come back',
        },
      ]}
    >
      {fresh && (
        <InfoPanel tone="success" title="Saved">
          The stock has come off your shelf, and anything unpaid is on the customer&rsquo;s
          account.
        </InfoPanel>
      )}

      <Receipt saleId={saleId} storeId={store.id} />
    </PageScaffold>
  );
}
