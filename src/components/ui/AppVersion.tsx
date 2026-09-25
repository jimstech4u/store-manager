'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from './Button';
import styles from './AppVersion.module.css';

/**
 * WHICH BUILD THIS IS, AND A WAY TO TAKE THE NEXT ONE NOW.
 *
 * An installed app updates by itself — the service worker fetches the new build, waits, and the
 * reload prompt offers it on the shop's own schedule. That is the right default and it is invisible,
 * which is the problem: when something is wrong there is no way to say which version it is wrong in,
 * and no way to answer "have you got the latest?" except by waiting.
 *
 * So: the running build, said plainly, and a button that checks. Checking is not the same as
 * updating and this does not pretend otherwise — if there is nothing new it says so and nothing
 * happens. If there is, reloading is the shop's decision, because a reload during a sale loses what
 * is being typed.
 *
 * ON A BROWSER TAB with no service worker at all — a desktop looking at the site — there is no build
 * to name and nothing to check. It says that rather than showing an empty box.
 */

/** Ask a worker which build it is. Null if it does not answer — an older one has no handler. */
function versionOf(worker: ServiceWorker | null): Promise<string | null> {
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => done(typeof e.data === 'string' ? e.data : null);
      worker.postMessage({ type: 'version' }, [channel.port2]);
      setTimeout(() => done(null), 2000);
    } catch {
      done(null);
    }
  });
}

type State =
  | { kind: 'asking' }
  | { kind: 'none' }
  | { kind: 'running'; version: string }
  | { kind: 'waiting'; version: string; next: string | null };

export function AppVersion() {
  const [state, setState] = useState<State>({ kind: 'asking' });
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<'same' | null>(null);

  const read = useCallback(async () => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      setState({ kind: 'none' });
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
    if (!reg) {
      setState({ kind: 'none' });
      return;
    }
    const running = await versionOf(reg.active);
    // `waiting` is a build already downloaded and sitting there — the reload prompt's own signal.
    const next = reg.waiting ? await versionOf(reg.waiting) : null;

    if (reg.waiting) {
      setState({ kind: 'waiting', version: running ?? 'unknown', next });
    } else if (running) {
      setState({ kind: 'running', version: running });
    } else {
      setState({ kind: 'none' });
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  const check = async () => {
    setChecking(true);
    setChecked(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
      // `update()` asks the server for the worker script. A new build changes its bytes, so the
      // browser installs it and it lands in `waiting`; an unchanged one is a no-op.
      await reg?.update();
      await read();
      const after = await navigator.serviceWorker.getRegistration().catch(() => null);
      if (!after?.waiting) setChecked('same');
    } catch {
      setChecked('same');
    } finally {
      setChecking(false);
    }
  };

  const take = async () => {
    const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
    if (!reg?.waiting) return;
    /*
     * The waiting worker is told to take over, and the page reloads once it has. Reloading first
     * would come back to the OLD build — the new one is still waiting until it is asked.
     */
    reg.waiting.postMessage({ type: 'skip-waiting' });
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), {
      once: true,
    });
  };

  if (state.kind === 'asking') return null;

  return (
    <div className={styles.wrap}>
      <div className={styles.row}>
        <span className={styles.label}>App version</span>
        <span className={styles.value}>
          {state.kind === 'none' ? 'Running in a browser tab' : state.version}
        </span>
      </div>

      {state.kind === 'waiting' ? (
        <>
          <p className={styles.ready}>
            A newer version is ready{state.next ? ` (${state.next})` : ''}.
          </p>
          {/*
            Reloading is the shop's decision. Mid-sale it would lose what is being typed, which is
            why this asks rather than applying itself.
          */}
          <Button size="large" fullWidth onClick={() => void take()}>
            Update now
          </Button>
          <p className={styles.note}>The app will reload. Finish what you are doing first.</p>
        </>
      ) : state.kind === 'running' ? (
        <>
          <Button
            variant="secondary"
            size="large"
            fullWidth
            busy={checking}
            busyLabel="Checking"
            onClick={() => void check()}
          >
            Check for an update
          </Button>
          {checked === 'same' && (
            <p className={styles.note}>This is the newest version.</p>
          )}
        </>
      ) : (
        <p className={styles.note}>
          Install the app to your home screen and it will keep itself up to date.
        </p>
      )}
    </div>
  );
}
