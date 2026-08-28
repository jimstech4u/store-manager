'use client';

import { useLocation } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { StockHistory } from '@/components/stock/StockHistory';
import { useStackBack } from '@/hooks/useStackBack';
import { useProduct } from '@/lib/stacks/catalog-stack';

/**
 * Everything that has ever happened to one item's stock.
 *
 * A PAGE of its own, not a section at the foot of the product.
 *
 * It was tried there and it does not belong: the product screen answers "what is this and what
 * does it cost", which is a glance, and a ledger is the opposite of a glance — it is what somebody
 * opens deliberately when the shelf disagrees with the records. Hundreds of rows under three facts
 * buried the facts and still made the history feel like an afterthought.
 *
 * ONLY THE ID TRAVELS. The product is re-read here from the same cache the product screen uses, so
 * a deep link or a reload lands on the same page rather than on a blank one — the rule the whole
 * app follows for pushed screens.
 */
export default function StockHistoryPage() {
  const goBack = useStackBack();
  const location = useLocation();

  const productId = (location?.params?.id as string | undefined) ?? null;
  const { product, settled } = useProduct(productId);

  if (!productId) return null;

  if (!product) {
    // Still fetching is not the same as missing — saying "not found" during the first second sends
    // somebody back to look for an item that is right there.
    return settled ? (
      <PageScaffold onBack={goBack} title="Stock history">
        <FullPageMessage title="That item could not be found">
          It may have been removed from your shop.
        </FullPageMessage>
      </PageScaffold>
    ) : (
      <FullPageMessage title="Opening the history" tone="loading" />
    );
  }

  return (
    <PageScaffold onBack={goBack} title="Stock history" subtitle={product.name}>
      <StockHistory productId={product.id} unit={product.baseUnit} />
    </PageScaffold>
  );
}
