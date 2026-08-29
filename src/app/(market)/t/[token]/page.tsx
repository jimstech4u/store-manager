import { TrackClient } from '../../track/TrackClient';

/**
 * A shared order, reached by its token.
 *
 * The five-character code is for SAYING — read across a counter, typed into the track page by
 * somebody standing in the shop. It is short because it has to be sayable, which means there are
 * few of them, which is why it is released when an order finishes and the next order takes it.
 *
 * This is the other identifier: long, random, never reused, and the one that goes in a link. A
 * message sits in somebody's chat for months, and a link that quietly starts pointing at a
 * stranger's order is a privacy failure rather than an inconvenience. It also answers for the
 * whole life of the order — what is being built, the receipt it became, or that it was cancelled
 * — so the customer is never sent a second link for the same purchase.
 */
export default async function SharedOrderPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <TrackClient initialToken={decodeURIComponent(token)} />;
}
