import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProduct, getShopProducts, imageUrl, productHref, productIdFromSlug } from '@/lib/marketplace/server';
import { MarketShell } from '@/app/(market)/MarketShell';
import styles from './product.module.css';

/**
 * ONE PRODUCT, WITH AN ADDRESS OF ITS OWN.
 *
 * Until now a product was a tap: it opened a sheet over the shop and set `?item=<uuid>`. Nothing a
 * crawler could follow, nothing a search engine could rank, and a link sent to somebody opened a
 * shop rather than the thing being talked about.
 *
 *     /s/7R8U2A/product/gulder-60cl~2d6ab81c-0e67-4bcd-ae22-38160f0f1965
 *
 * The words are for people and for search results; everything after the first `~` is the id it is
 * actually looked up by. So a product can be renamed, or translated, and every link already sent
 * still opens the right thing.
 *
 * Rendered on the server, because the audience for this page arrives before any JavaScript does: a
 * crawler, a WhatsApp preview, somebody opening a link on a bad connection.
 */

export const revalidate = 300;

type Params = { params: Promise<{ code: string; slug: string }> };

async function load(slugParam: string) {
  const id = productIdFromSlug(slugParam);
  return id ? getProduct(id) : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const product = await load(slug);

  // Not found, or no longer public. Better to say nothing than to describe something that has gone.
  if (!product) return { title: 'Product', robots: { index: false } };

  const price = product.price ? `₦${Number(product.price).toLocaleString('en-NG')}` : null;
  const title = price
    ? `${product.name} — ${price} at ${product.store_name}`
    : `${product.name} at ${product.store_name}`;
  const description = [
    `${product.name} from ${product.store_name}.`,
    price ? `${price} per ${product.unit_label}.` : null,
    product.in_stock ? 'In stock now.' : 'Currently out of stock.',
  ]
    .filter(Boolean)
    .join(' ');

  const image = imageUrl(product.image_path);
  const canonical = productHref(product);

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      type: 'website',
      url: canonical,
      title: `${product.name} — ${product.store_name}`,
      description,
      ...(image ? { images: [{ url: image, alt: product.name }] } : {}),
    },
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title: product.name,
      description,
    },
  };
}

export default async function Page({ params }: Params) {
  const { code, slug } = await params;
  const product = await load(slug);
  if (!product) notFound();

  const price = product.price ? Number(product.price) : null;
  const image = imageUrl(product.image_path);

  /*
   * What a search result shows: the price, whether it is in stock, and who sells it. Without this a
   * listing is a blue link; with it, it can carry the price — which for somebody comparing shops is
   * most of the decision.
   */
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    ...(image ? { image: [image] } : {}),
    description: `${product.name} from ${product.store_name}`,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'NGN',
      ...(price !== null ? { price: String(price) } : {}),
      availability: product.in_stock
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      seller: { '@type': 'Organization', name: product.store_name },
    },
  };

  // Other things from the same shop, as real links — this is how a crawler walks a catalogue, and
  // how a person carries on browsing.
  const others = (await getShopProducts(product.store_id, 13)).filter((p) => p.id !== product.id).slice(0, 12);

  /*
   * The same shell as the rest of the marketplace, so this page has the brand row and the same way
   * out — and so somebody who is signed in is offered "My shop" rather than "Sign in", which is what
   * every other public page already does. A product page arrived at from a search result is often
   * the FIRST page somebody sees, so it cannot be the one that looks like a different site.
   */
  return (
    <MarketShell>
    <main className={styles.wrap}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link href="/">Marketplace</Link>
        <span aria-hidden> › </span>
        <Link href={`/s/${code}`}>{product.store_name}</Link>
      </nav>

      <article className={styles.product}>
        {image && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img className={styles.image} src={image} alt={product.name} width={640} height={640} />
        )}

        <h1 className={styles.name}>{product.name}</h1>
        <p className={styles.shop}>
          Sold by <Link href={`/s/${code}`}>{product.store_name}</Link>
        </p>

        {price !== null && (
          <p className={styles.price}>
            ₦{price.toLocaleString('en-NG')} <span className={styles.unit}>per {product.unit_label}</span>
          </p>
        )}

        <p className={product.in_stock ? styles.inStock : styles.outOfStock}>
          {product.in_stock ? 'In stock' : 'Out of stock'}
        </p>

        {product.has_bulk && <p className={styles.bulk}>Cheaper per unit when you buy more.</p>}

        <Link className={styles.cta} href={`/s/${code}`}>
          See everything from {product.store_name}
        </Link>
      </article>

      {others.length > 0 && (
        <section className={styles.more} aria-labelledby="more-from-shop">
          <h2 id="more-from-shop" className={styles.moreHeading}>
            More from {product.store_name}
          </h2>
          <ul className={styles.moreList}>
            {others.map((p) => (
              <li key={p.id}>
                <Link href={productHref(p)} className={styles.moreLink}>
                  {p.name}
                  {p.price ? <span className={styles.morePrice}>₦{Number(p.price).toLocaleString('en-NG')}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
    </MarketShell>
  );
}
