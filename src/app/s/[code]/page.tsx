import type { Metadata } from 'next';
import { getShop, getShopProducts, imageUrl } from '@/lib/marketplace/server';
import ShopPage from './shop-page';
import ProductList from '@/components/market/ProductList';

/**
 * A SHOP, ANSWERED ON THE SERVER.
 *
 * The screen itself is still the client page it always was — the search, the filters, the infinite
 * scroll. What was missing is everything that happens BEFORE any of that runs, and it is the part
 * that decides whether a shop can be found or shared at all:
 *
 *   · a title of its own, instead of every page in the app reporting "Store Manager"
 *   · a description and an og:image, so a link sent in WhatsApp shows the shop rather than a blank
 *   · a canonical, so `/s/7R8U2A` and `/s/7R8U2A?ref=x` are one page and not two
 *
 * None of that can come from the client: a link preview never runs JavaScript, and a crawler reads
 * the document before it decides whether to render anything.
 */

export const revalidate = 300;

type Params = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { code } = await params;
  const shop = await getShop(code);

  // A shop that cannot be read is not a 500 and not a lie: the page still renders, and a crawler is
  // told nothing rather than something wrong.
  if (!shop) return { title: 'Shop', robots: { index: false } };

  const products = await getShopProducts(shop.id, 3);
  const sample = products.map((p) => p.name).filter(Boolean).slice(0, 3).join(', ');
  const description =
    shop.description?.trim() ||
    (sample
      ? `Buy ${sample} and more from ${shop.name}. Prices, bulk rates and what is in stock.`
      : `${shop.name} on Store Manager. Prices, bulk rates and what is in stock.`);

  const image = imageUrl(products.find((p) => p.image_path)?.image_path);

  return {
    title: `${shop.name} — prices and what is in stock`,
    description,
    alternates: { canonical: `/s/${shop.code}` },
    openGraph: {
      type: 'website',
      title: shop.name,
      description,
      url: `/s/${shop.code}`,
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: { card: image ? 'summary_large_image' : 'summary', title: shop.name, description },
  };
}

export default async function Page({ params }: Params) {
  const { code } = await params;
  const shop = await getShop(code);

  return (
    <>
      <ShopPage code={code} />
      {/*
        The grid inside ShopPage is fetched in the browser, so nothing reading the document sees a
        single product. This is the same catalogue, rendered here, as plain links with prices — for
        a crawler, and for anybody whose JavaScript has not arrived yet.
      */}
      {shop && <ProductList storeId={shop.id} heading={`Everything from ${shop.name}`} />}
    </>
  );
}
