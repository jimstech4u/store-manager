import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/** One person's own orders. Nothing here for a search engine, same as the basket. */
export const metadata: Metadata = {
  title: 'Your orders — Store Manager',
  robots: { index: false, follow: true },
};

export default function OrdersLayout({ children }: { children: ReactNode }) {
  return children;
}
