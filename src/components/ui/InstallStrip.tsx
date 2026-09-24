'use client';

import { useEffect, useState } from 'react';
import { useInstallApp } from '@/hooks/useInstallApp';
import { InstallApp } from '@/components/ui/InstallApp';
import styles from './InstallStrip.module.css';

/**
 * THE OFFER TO INSTALL, OUT OF THE WAY OF THE PAGE.
 *
 * This used to sit inside the hero, under "Open a shop" and "Sign in" — two numbered steps in grey
 * on a dark green photograph, permanently on, with nothing to tap on Android. It read as debris left
 * under the buttons rather than an offer, and it was competing for the top of a page whose whole job
 * is to get somebody browsing.
 *
 * A strip at the foot is the right shape for it: present, ignorable, and gone for good once it is
 * dismissed. The steps — which are only needed on platforms that cannot offer a one-tap install —
 * stay folded until somebody asks for them.
 */

const DISMISSED = 'install-strip-dismissed';

export function InstallStrip() {
  const { way, install } = useInstallApp();
  const [hidden, setHidden] = useState(true);
  const [open, setOpen] = useState(false);

  /*
   * Hidden until the browser has been read, rather than shown and then taken away. Reading storage
   * during render would also differ between the server and the client, and React would say so.
   */
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(DISMISSED) === '1');
    } catch {
      setHidden(false);
    }
  }, []);

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {
      // A private window asks again next time. That is the whole cost.
    }
  };

  if (hidden || way === 'installed' || way === 'not-offered') return null;

  return (
    <div className={styles.strip} role="complementary" aria-label="Install this app">
      <div className={styles.row}>
        <span className={styles.icon} aria-hidden>📲</span>
        <p className={styles.text}>
          Keep your shop one tap away
          <span className={styles.sub}>Add it to your home screen</span>
        </p>

        {way === 'one-tap' ? (
          <button type="button" className={styles.action} onClick={() => void install()}>
            Add
          </button>
        ) : (
          <button type="button" className={styles.action} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Hide' : 'How'}
          </button>
        )}

        <button type="button" className={styles.close} onClick={dismiss} aria-label="Not now">
          ✕
        </button>
      </div>

      {/* Only where the platform cannot do it in one tap: iPhone's two steps, or a browser's menu. */}
      {open && (
        <div className={styles.steps}>
          <InstallApp label="Add to my home screen" />
        </div>
      )}
    </div>
  );
}
