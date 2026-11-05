'use client';

import type { ReactNode } from 'react';
import styles from './ActionTiles.module.css';

export interface ActionTile {
  key: string;
  icon: ReactNode;
  /** What is printed under the icon — one or two words. */
  label: string;
  /**
   * The whole sentence, for a screen reader and for tests. It CONTAINS the label, so what is read
   * out is what is seen.
   */
  ariaLabel?: string;
  onClick: () => void;
  /** A count worth opening for ("3 going off"). */
  badge?: number;
}

/**
 * THE PAGE'S OTHER DOORS, WITH THEIR NAMES ON.
 *
 * Stock had five bare icons in its header — an exclamation mark, a warning triangle, a box, two
 * people and a plus — and Money three. Each was a guess until it was tapped: "which of these is
 * suppliers?" is not a question anybody at a counter should have to answer twice. A row of tiles,
 * each a picture AND a word, the way a banking app lays out what can be done from its first screen.
 */
export function ActionTiles({
  tiles,
  label,
  className,
}: {
  tiles: ActionTile[];
  label: string;
  className?: string;
}) {
  if (tiles.length === 0) return null;
  return (
    <nav className={`${styles.tiles} ${className ?? ''}`} aria-label={label}>
      {tiles.map((t) => (
        <button
          key={t.key}
          type="button"
          className={styles.tile}
          onClick={t.onClick}
          aria-label={t.ariaLabel}
        >
          <span className={styles.icon} aria-hidden>
            {t.icon}
            {t.badge != null && t.badge > 0 && <span className={styles.badge}>{t.badge}</span>}
          </span>
          <span className={styles.label}>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
