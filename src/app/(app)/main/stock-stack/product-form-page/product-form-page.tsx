'use client';

import { useLocation, useNav, useObject } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { ProductForm, type ProductFormResult } from '@/components/catalog/ProductForm';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { catalogChanged, useProduct } from '@/lib/stacks/catalog-stack';

/**
 * Adding an item you sell, or changing one — a page.
 *
 * ONLY AN ID TRAVELS IN THE URL. The product itself comes from `useProduct`, which owns the
 * `product:<id>` cache, so opening the edit form for something already on screen draws it filled
 * in immediately and a pasted link still works from cold. Putting the product's fields in the
 * params instead would have made the URL a copy of a record — one that goes stale the moment
 * anybody edits it, and that a person can hand-edit into a form claiming to be a product it is not.
 *
 * HANDING THE RESULT BACK. A pushed page has no return value: `nav.push` resolves when the page is
 * shown, not when it is finished with. The caller that needs the result — the sell screen, which
 * asked for an item mid-receipt — publishes a callback with `nav.provideObject('onProductSaved')`
 * and this page picks it up with `useObject`. Nothing else needs it: the stock list and the
 * product page just re-read the catalogue, which `catalogChanged()` already makes them do.
 */
export default function ProductFormPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const productId = (location?.params?.id as string | undefined) ?? null;
  const prefillName = (location?.params?.name as string | undefined) ?? '';

  const { product, settled } = useProduct(productId);

  /*
   * The caller's "I want the result" hook, if there is one.
   *
   * Global scope rather than page scope: the provider is the sell page, which is in a DIFFERENT
   * stack from this one when the form is opened mid-sale. A page-scoped object is addressed by the
   * providing page's uid and would never be found from here.
   */
  const onSavedObj = useObject<(result: ProductFormResult) => void>('onProductSaved', {
    global: true,
    scope: 'catalog',
  });

  if (!store) return null;

  // Editing something whose record has not arrived yet. The form would otherwise mount empty and
  // fill in underneath the seller's fingers.
  if (productId && !settled) {
    return <FullPageMessage title="Loading this item" tone="loading" />;
  }

  return (
    <PageScaffold
      onBack={goBack}
      title={productId ? 'Edit this item' : 'Add an item you sell'}
      subtitle={
        productId ? 'Change what this item is called and costs' : 'Something new for your shelf'
      }
    >
      <ProductForm
        storeId={store.id}
        product={product}
        initialName={prefillName}
        onCancel={() => void nav.pop()}
        onSaved={(result) => {
          // Say the catalogue moved, so every list showing this product re-reads it.
          catalogChanged();
          // `getter()` unwraps to the callback the caller published. It is checked rather than
          // assumed because most callers do not publish one at all.
          if (onSavedObj.isProvided) {
            const notify = onSavedObj.getter();
            if (notify) notify(result);
          }
          void nav.pop();
        }}
      />
    </PageScaffold>
  );
}
