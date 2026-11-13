'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

/**
 * THE LAST CATCH — a page that crashed while drawing. Reported to Sentry, and the person is offered
 * the one thing that helps at a counter: start the app again. Nothing they entered is lost by that:
 * open orders live on the server.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f4f6f5', color: '#1b2a24' }}>
        <main style={{ maxWidth: 420, margin: '0 auto', padding: '64px 16px', textAlign: 'center' }}>
          <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>Something went wrong</h1>
          <p style={{ margin: '0 0 24px', lineHeight: 1.5 }}>
            The app hit a problem and has told us about it. Open orders are saved on the till.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              font: 'inherit', fontWeight: 600, padding: '12px 20px', borderRadius: 12, border: 0,
              background: '#0f6b4f', color: '#fff', cursor: 'pointer', minHeight: 48,
            }}
          >
            Start again
          </button>
        </main>
      </body>
    </html>
  );
}
