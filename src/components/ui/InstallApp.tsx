'use client';

import { Button } from '@/components/ui/Button';
import { useInstallApp } from '@/hooks/useInstallApp';
import styles from './InstallApp.module.css';

/**
 * PUT IT ON THE PHONE — offered wherever somebody would look for it.
 *
 * On Android this is ONE tap: the button calls the browser's own install, and the system sheet is
 * the only other thing they see. On iPhone there is no such button to press — Apple keeps installing
 * inside the Share sheet — so the two steps are said plainly rather than pretending otherwise.
 *
 * Nothing is drawn once it is installed (or on a desktop browser that will not offer it), because
 * an offer to do what has already been done is noise on the one screen a shop uses all day.
 */
export function InstallApp({
  label = 'Put this on my phone',
  note,
}: {
  /** The words on the button, where the page wants its own. */
  label?: string;
  /** A line under it, when the surrounding page does not already explain. */
  note?: string;
}) {
  const { way, install } = useInstallApp();

  if (way === 'installed' || way === 'not-offered') return null;

  return (
    <div className={styles.wrap}>
      {way === 'one-tap' ? (
        <>
          <Button size="large" fullWidth onClick={() => void install()}>
            {label}
          </Button>
          {note && <p className={styles.note}>{note}</p>}
        </>
      ) : (
        <>
          {/*
            iPhone. No prompt exists to call, so the steps are the offer — and they are two, which
            is as short as Apple allows.
          */}
          <ol className={styles.steps}>
            <li className={styles.step}>
              <span className={styles.stepNumber}>1</span>
              <span>
                Tap <strong>Share</strong> at the bottom of Safari
              </span>
            </li>
            <li className={styles.step}>
              <span className={styles.stepNumber}>2</span>
              <span>
                Choose <strong>Add to Home Screen</strong>
              </span>
            </li>
          </ol>
          {note && <p className={styles.note}>{note}</p>}
        </>
      )}
    </div>
  );
}
