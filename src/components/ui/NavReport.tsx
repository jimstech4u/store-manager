'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import styles from './NavReport.module.css';

const KEY = 'nav-report';

function isOn(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * A NAVIGATION REPORT, from the phone it happened on.
 *
 * "why am I pressing Back on the Stock tab and I get to the Sell page, in the PWA." It could not be
 * made to happen in Chrome or in Safari's engine on a computer — straight, after a reload, after a
 * cold start with the stacks restored — so the evidence has to come from the shop's own phone.
 *
 * navigation-stack records every push, pop and tab switch when its devtools are on; they are off in
 * production. This turns them on for THIS device (the switch is read in the root layout, before the
 * app starts), and hands back the recording as text to send. Nothing leaves the phone unless the
 * shop copies it.
 */
export function NavReport() {
  // Read after mounting: the server has no localStorage, and must render the same first frame.
  const [on, setOn] = useState(false);
  useEffect(() => setOn(isOn()), []);
  const [note, setNote] = useState<string | null>(null);

  const toggle = () => {
    try {
      if (on) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, '1');
    } catch {
      setNote('This phone would not keep the setting.');
      return;
    }
    setOn(!on);
    // The recorder is switched on as the app starts, so it starts again.
    window.location.reload();
  };

  const copy = async () => {
    setNote(null);
    const nav = (window as { __NAV_STACK__?: { debug?: () => unknown } }).__NAV_STACK__;
    const report = JSON.stringify(
      { at: new Date().toISOString(), agent: navigator.userAgent, url: location.href, nav: nav?.debug?.() ?? null },
      null,
      1,
    );
    try {
      await navigator.clipboard.writeText(report);
      setNote('Copied. Paste it into a message to whoever is fixing it.');
    } catch {
      setNote('This phone would not copy it. Try Share instead.');
    }
  };

  const share = async () => {
    const nav = (window as { __NAV_STACK__?: { debug?: () => unknown } }).__NAV_STACK__;
    const text = JSON.stringify({ at: new Date().toISOString(), url: location.href, nav: nav?.debug?.() ?? null });
    try {
      await navigator.share?.({ title: 'Navigation report', text });
    } catch {
      // A cancelled share sheet is not a failure.
    }
  };

  return (
    <section className={styles.block}>
      <p className={styles.lead}>
        {on
          ? 'Recording is on. Do what went wrong — the Back that took you somewhere else — then come back here and copy the report.'
          : 'If Back ever takes you to the wrong tab or a blank page, turn this on, make it happen once, and send the report.'}
      </p>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={toggle}>
          {on ? 'Stop recording' : 'Record navigation'}
        </Button>
        {on && <Button onClick={() => void copy()}>Copy the report</Button>}
        {on && typeof navigator !== 'undefined' && 'share' in navigator && (
          <Button variant="secondary" onClick={() => void share()}>
            Share
          </Button>
        )}
      </div>
      {note && (
        <p className={styles.note} role="status">
          {note}
        </p>
      )}
    </section>
  );
}
