'use client';

import styles from './LoadingView.module.css';

/**
 * "Working on it", everywhere it needs saying.
 *
 * Same shape as academix-web's `LoadingView` — a mark, an optional line of text — so a screen
 * moved between the two apps behaves the same. The mark itself is this product's: academix-web
 * plays a branded Lottie, and shipping that here would put another product's animation in a shop
 * owner's till.
 *
 * DRAWN, NOT A LOTTIE. A stock-taking app opened on a cheap phone over a slow connection should
 * not fetch and parse a JSON animation to say "one moment" — the spinner has to be the fastest
 * thing on the page, not another thing that has to load. This is one inline SVG in the brand
 * colour, and it costs nothing.
 *
 * `aria-live` rather than `role="alert"`: waiting is a status, not an alarm, and a screen reader
 * should mention it without interrupting whatever it is reading.
 */
export function LoadingView({
  text = null,
  /** Fills its container rather than sitting in a 200px band — for a whole page. */
  full = false,
}: {
  text?: string | null;
  full?: boolean;
}) {
  return (
    <div className={`${styles.container} ${full ? styles.full : ''}`} role="status" aria-live="polite">
      <svg
        className={styles.spinner}
        viewBox="0 0 50 50"
        aria-hidden="true"
        focusable="false"
      >
        {/* The track, so the moving arc reads as travelling around something. */}
        <circle className={styles.track} cx="25" cy="25" r="20" fill="none" strokeWidth="5" />
        <circle className={styles.arc} cx="25" cy="25" r="20" fill="none" strokeWidth="5" />
      </svg>
      {text && <p className={styles.text}>{text}</p>}
    </div>
  );
}
