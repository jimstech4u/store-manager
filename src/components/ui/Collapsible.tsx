'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import styles from './Collapsible.module.css';
import { ChevronDownIcon } from './Icon';

/**
 * A section that collapses to a summary line and expands on tap.
 *
 * The sell screen is the reason this exists: several customers, a growing list of lines, totals,
 * a fee, a note — all of it needed, none of it needed at once. Collapsing the parts that are
 * settled gives the part being worked on room, which matters most on the small screen where
 * there is least of it.
 *
 * The summary always shows the number that would have made you open it — a line count, a total —
 * so collapsing hides detail without hiding information. A collapsed section that says nothing
 * just becomes a thing people must open every time.
 *
 * Height is animated from a measured pixel value rather than to `auto`, which does not animate.
 * The measurement is re-taken whenever the content changes, so a section that grows while open
 * does not end up clipped at its old height.
 */
export function Collapsible({
  title,
  summary,
  defaultOpen = true,
  children,
  tone = 'plain',
}: {
  title: string;
  /** The fact worth seeing while collapsed — a count, a total. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  tone?: 'plain' | 'card';
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [height, setHeight] = useState<number | undefined>(undefined);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const id = useId();

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;

    const measure = () => setHeight(el.scrollHeight);
    measure();

    // Content inside can change while open — a line added, a warning appearing — and a fixed
    // height taken once would clip it.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children]);

  return (
    <section className={`${styles.wrap} ${tone === 'card' ? styles.card : ''}`}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
      >
        <span className={styles.titles}>
          <span className={styles.title}>{title}</span>
          {/* Kept visible in both states: while collapsed it is the whole point, and while open
              it stops the header looking like it lost something. */}
          {summary && <span className={styles.summary}>{summary}</span>}
        </span>
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </button>

      <div
        id={id}
        className={styles.clip}
        style={{ height: open ? height ?? 'auto' : 0 }}
        // Hidden from assistive tech as well as sight while collapsed, so a screen reader does
        // not read out a section the screen is not showing.
        aria-hidden={!open}
      >
        <div ref={bodyRef} className={styles.body}>
          {children}
        </div>
      </div>
    </section>
  );
}
