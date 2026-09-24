import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * The basket is one person's, kept on one device — there is nothing here for a search engine to
 * find, and an indexed /cart in a SERP is a dead result. It is deliberately NOT in the sitemap
 * either; this says the same thing to a crawler that arrives by following the top bar's link.
 */
export const metadata: Metadata = {
  title: 'Your basket — Store Manager',
  robots: { index: false, follow: true },
};

export default function CartLayout({ children }: { children: ReactNode }) {
  return children;
}
