'use client';

import type { ReactNode } from 'react';
import styles from './PinnedTools.module.css';

/**
 * A LIST PAGE'S TOOLS STAY IN REACH: its search, its filters, its export.
 *
 * "Adapt the push header and pin a section we did in sell-page across the other pages … so when
 * users scroll a list, they can still click search, and we can push the header away so search can
 * be visible and more space."
 *
 * The till already works this way: its header travels with the page (`PageScaffold headerScrolls`)
 * and the customer bar sticks to the top in its place. A long list is the same situation — two
 * hundred products down, the way to find the two hundred and first is the search box, and it was at
 * the top of the page, scrolled away with everything else.
 *
 * Use it with `headerScrolls` on the page's `PageScaffold`: two things cannot both own the top of
 * the screen, and the title is the one that can go.
 */
export function PinnedTools({ children }: { children: ReactNode }) {
  return <div className={styles.pinned}>{children}</div>;
}
