'use client';

import type { ReactNode } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import styles from './RecordLink.module.css';

/**
 * A RECORD'S NAME, WHERE IT IS MENTIONED, OPENS IT.
 *
 * «if i am viewing a record and that record is a sub of another record, it can point to it
 *  likewise if it is a parent of records»
 *
 * The customer on a receipt opens their account; an item on a receipt, a ledger or an expiry row
 * opens the item. Every page is registered in every tab (`record-pages.tsx`), so this pushes onto
 * the tab you are in and Back returns to where you were — no trip out through another tab.
 */
export function RecordLink({
  route,
  id,
  className,
  children,
}: {
  route: string;
  id: string;
  className?: string;
  children: ReactNode;
}) {
  const nav = useNav();
  return (
    <button
      type="button"
      className={`${styles.link} ${className ?? ''}`}
      onClick={(e) => {
        // A link inside a tappable row opens ITS record, not the row's.
        e.stopPropagation();
        void nav.push(route, { id });
      }}
    >
      {children}
    </button>
  );
}
