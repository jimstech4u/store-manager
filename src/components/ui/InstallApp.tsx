'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useInstallApp } from '@/hooks/useInstallApp';
import styles from './InstallApp.module.css';

/**
 * PUT IT ON THE PHONE — offered wherever somebody would look for it, in that browser's own terms.
 *
 * Android gets ONE tap: the button calls the browser's own install and the system sheet is the only
 * other thing they see. iPhone gets two steps, because Apple keeps installing inside the Share sheet
 * and exposes no API — and an iPhone in Chrome gets the truth, which is that the Home Screen belongs
 * to Safari there and nothing else on that phone can do it.
 *
 * Nothing is drawn once it is installed, or on a desktop browser that will not offer it: an offer to
 * do what has already been done is noise on the one screen a shop uses all day.
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
  const { way, install, openInSafari } = useInstallApp();
  const [copied, setCopied] = useState(false);

  if (way === 'installed' || way === 'not-offered') return null;

  const steps = (items: string[]) => (
    <ol className={styles.steps}>
      {items.map((text, i) => (
        <li key={text} className={styles.step}>
          <span className={styles.stepNumber}>{i + 1}</span>
          <span dangerouslySetInnerHTML={{ __html: text }} />
        </li>
      ))}
    </ol>
  );

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={styles.wrap}>
      {way === 'one-tap' && (
        <Button size="large" fullWidth onClick={() => void install()}>
          {label}
        </Button>
      )}

      {/*
        An iPhone in Chrome, Firefox or Edge. Those browsers render the page but cannot put it on the
        Home Screen — that is Safari's alone on iOS. `x-safari-` is Apple's own way to hand a page
        over, and it is not a standard, so the address is offered as well.
      */}
      {way === 'ios-needs-safari' && (
        <>
          <p className={styles.note}>
            On iPhone, only Safari can add an app to the Home Screen.
          </p>
          <div className={styles.row}>
            <Button fullWidth onClick={openInSafari}>
              Open in Safari
            </Button>
            <Button variant="secondary" fullWidth onClick={() => void copyLink()}>
              {copied ? 'Link copied' : 'Copy the link'}
            </Button>
          </div>
          <p className={styles.note}>
            Then in Safari: <strong>Share</strong> → <strong>Add to Home Screen</strong>.
          </p>
        </>
      )}

      {way === 'ios-steps' &&
        steps([
          'Tap <strong>Share</strong> at the bottom of Safari',
          'Choose <strong>Add to Home Screen</strong>',
        ])}

      {/*
        Android, before the browser has offered us its install (it only does so once the page has
        been served over HTTPS with a manifest and a worker, and sometimes only after a visit or
        two). The menu is always there, so say where it is rather than showing nothing.
      */}
      {way === 'browser-menu' &&
        steps([
          'Open your browser&rsquo;s <strong>menu</strong> (⋮ at the top)',
          'Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>',
        ])}

      {note && <p className={styles.note}>{note}</p>}
    </div>
  );
}
