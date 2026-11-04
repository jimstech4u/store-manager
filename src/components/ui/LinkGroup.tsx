'use client';

import { useId, type ReactNode } from 'react';
import { ChevronRightIcon } from '@/components/ui/Icon';
import styles from './LinkGroup.module.css';

/**
 * A HEADED CARD OF ROWS, each a place to go — the shape every phone's own settings screen has.
 *
 * Settings was a heading, a full-width outlined button with centred text, and a grey paragraph under
 * it, repeated: it read as a form with nine submit buttons rather than a list of places. Rows in one
 * card under one heading say "these belong together", an icon finds the row before the words are
 * read, and the chevron says it opens somewhere.
 */
export function LinkGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className={styles.group}>
      {title && <h2 className={styles.title}>{title}</h2>}
      <div className={styles.card}>{children}</div>
    </section>
  );
}

export function LinkRow({
  icon,
  title,
  note,
  badge,
  value,
  onClick,
  href,
  tone,
  current,
  disabled,
}: {
  icon?: ReactNode;
  title: string;
  note?: ReactNode;
  /** A count worth acting on. */
  badge?: number;
  /** A short state on the right ("Relaxed", "Dark"). */
  value?: ReactNode;
  onClick?: () => void;
  /** An address outside the app, opened in a new tab. */
  href?: string;
  tone?: 'danger' | 'primary';
  /** The one that is in use, marked rather than merely highlighted. */
  current?: boolean;
  disabled?: boolean;
}) {
  const noteId = useId();
  const body = (
    <>
      {icon && <span className={`${styles.icon} ${tone === 'danger' ? styles.iconDanger : ''}`} aria-hidden>{icon}</span>}
      <span className={styles.main}>
        <span className={`${styles.name} ${tone ? styles[tone] : ''}`}>{title}</span>
        {note && (
          <span id={noteId} className={styles.note}>
            {note}
          </span>
        )}
      </span>
      {value != null && <span className={styles.value}>{value}</span>}
      {badge != null && badge > 0 && <span className={styles.badge}>{badge}</span>}
      {!current && !tone && <ChevronRightIcon className={styles.chevron} />}
    </>
  );
  // The name is the title, so a row is found by what it is called; the note describes it.
  const common = {
    className: `${styles.row} ${current ? styles.current : ''}`,
    'aria-label': title,
    'aria-describedby': note ? noteId : undefined,
  };
  if (href) {
    return (
      <a {...common} href={href} target="_blank" rel="noopener noreferrer">
        {body}
      </a>
    );
  }
  return (
    <button {...common} type="button" onClick={onClick} disabled={disabled || current} aria-current={current || undefined}>
      {body}
    </button>
  );
}
