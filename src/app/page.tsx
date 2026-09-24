import type { Metadata } from 'next';
import MarketLanding from './market-landing';
import ShopDirectory from '@/components/market/ShopDirectory';

/**
 * THE MARKETPLACE, ANSWERED ON THE SERVER FIRST.
 *
 * What a crawler received here was fifteen kilobytes of shell: no shop, no product, no price, and
 * not one `<a href>` to follow. The grid is fetched in the browser and every card is a button, so
 * there was nothing to read and nowhere to go. Measured, not assumed — `probe-crawlable` counted
 * zero anchors.
 *
 * Two things fix it, and neither changes the app anybody uses:
 *
 *   · the page declares itself — a title, a description, an og:image — so a link sent in a WhatsApp
 *     group shows a marketplace rather than a blank card
 *   · a directory of real links underneath it, so a crawler can walk from here to a shop and from a
 *     shop to its prices
 *
 * The directory is visible to people as well. Anything written for a crawler that a person cannot
 * see is cloaking, and it is also a lie about what the page is.
 */

export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Buy from shops near you — Store Manager',
  description:
    'Browse what local distributors have in stock, with their prices — including bulk prices when you buy more. Run a shop yourself and keep stock, sales and customer accounts straight in one place.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: '/',
    title: 'Buy from shops near you',
    description:
      'Browse what local distributors have in stock, with their prices — including bulk prices when you buy more.',
    images: [{ url: '/icons/icon-512.png' }],
  },
  twitter: {
    card: 'summary',
    title: 'Buy from shops near you',
    description: 'Browse what local distributors have in stock, with their prices.',
  },
};

export default function Page() {
  return (
    <>
      <MarketLanding />
      <ShopDirectory />
    </>
  );
}
