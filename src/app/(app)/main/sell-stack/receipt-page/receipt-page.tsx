'use client';

import { useLocation } from '@academix-admin/navigation-stack';
import { useNav } from '@academix-admin/navigation-stack';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { InfoPanel } from '@/components/ui/Explain';
import { Button } from '@/components/ui/Button';
import { usePermission } from '@/hooks/usePermission';
import styles from './receipt-page.module.css';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { Receipt } from '../sell-page/Receipt';

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
  const { can } = usePermission();

  const saleId = (location?.params?.id as string | undefined) ?? null;
  const fresh = location?.params?.fresh === '1';

  if (!store) return null;

  // No sale named (an edited URL): said inside the page's one header.
  const status: PageStatus = saleId
    ? { state: 'ready' }
    : {
        state: 'empty',
        title: 'Open a sale to see its receipt',
        body: 'Receipts are reached from a sale, or from the money screen.',
      };

  return (
    <PageScaffold
      onBack={goBack}
      title={fresh ? 'Sale recorded' : 'Receipt'}
      subtitle={store.name}
    >
      <PageState status={status}>
        {() =>
          saleId && (
            <>
      {fresh && (
        <InfoPanel tone="success" title="Saved">
          The stock has come off your shelf, and anything unpaid is on the customer&rsquo;s
          account.
        </InfoPanel>
      )}

      {/*
        THE WAY TO CORRECT IT, behind the permission that already governs voiding — handed to the
        receipt so it appears with it, not under the loader before it.

        Secondary and below the receipt, because reading one is the job of this screen and
        correcting one is rare. It is a PAGE rather than a sheet: it is a form, it survives a
        rotation, and the keyboard would cover half of a sheet on a phone.
      */}
      <Receipt
        saleId={saleId}
        storeId={store.id}
        after={
          can('sales.amend') && (
            <div className={styles.correct}>
              <Button
                variant="secondary"
                fullWidth
                onClick={() => void nav.push('amend_page', { id: saleId })}
              >
                Something on this is wrong
              </Button>
            </div>
          )
        }
      />
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
