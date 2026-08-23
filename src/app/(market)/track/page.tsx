import { Suspense } from 'react';
import { TrackClient } from './TrackClient';

/**
 * `useSearchParams` forces a client bail-out, and Next refuses to prerender a page that reads it
 * without a Suspense boundary. The boundary is here rather than inside the client component
 * because it has to exist ABOVE the component doing the reading.
 *
 * The fallback is deliberately plain: this page is opened by someone standing at a counter being
 * told a code, and a skeleton pretending to be an order would be read as an order.
 */
export default function TrackPage() {
  return (
    <Suspense fallback={null}>
      <TrackClient />
    </Suspense>
  );
}
