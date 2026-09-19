'use client';

import type { ReactNode } from 'react';
import { Button } from './Button';
import { FullPageMessage } from './FullPageMessage';

/**
 * What a page's BODY shows: its content, or — until there is some — loading, or what went wrong.
 *
 * Inside the page's own `PageScaffold`, never instead of it. The header (title, back, actions) is
 * drawn once and stays; only this part changes. Pages used to return early with a `FullPageMessage`,
 * which threw the header away — no title, no way back while a read was in flight, and a "Try again"
 * on a screen that did not say what it was. academix-web draws its header and puts `LoadingView` /
 * `ErrorView` underneath (`redeem-codes`: one view at a time, data > loading > error > empty).
 *
 * `children` is a FUNCTION so that nothing inside it — `account.balance`, `product.name` — is
 * evaluated until the data it reads exists.
 */
export type PageStatus =
  | { state: 'ready' }
  | { state: 'loading'; what: string }
  | { state: 'error'; what: string; error?: string | null; onRetry?: () => void }
  | { state: 'empty'; title: string; body?: ReactNode };

export function PageState({ status, children }: { status: PageStatus; children: () => ReactNode }) {
  switch (status.state) {
    case 'loading':
      return <FullPageMessage inPage tone="loading" title={`Loading ${status.what}`} />;
    case 'error':
      return (
        <FullPageMessage
          inPage
          tone="error"
          title={`Could not load ${status.what}`}
          action={
            status.onRetry ? (
              <Button fullWidth onClick={status.onRetry}>
                Try again
              </Button>
            ) : undefined
          }
        >
          {status.error}
        </FullPageMessage>
      );
    case 'empty':
      return (
        <FullPageMessage inPage tone="empty" title={status.title}>
          {status.body}
        </FullPageMessage>
      );
    default:
      return <>{children()}</>;
  }
}
