import type { ReactNode } from 'react';
import { BoxIcon, CashIcon, ReceiptIcon, SettingsIcon } from '@/components/ui/Icon';
import type { Permission } from '@/lib/permissions';

/**
 * The tab bar, as data.
 *
 * Deliberately separate from the shell that renders it. academix-web declares its equivalent
 * inline inside the page component, with each tab's icon written out as a raw <path d="…"> — the
 * config there runs to roughly 150 lines of SVG data before any layout code begins, which makes
 * the actual navigation logic hard to find and an icon impossible to reuse anywhere else.
 *
 * Here the icons come from the shared set (so the same glyph appears identically in a tab, a
 * button and an empty state), and each tab carries the permission that gates it, so the bar is
 * built from what this user may actually do rather than rendering tabs that lead to a locked
 * screen.
 */

export interface TabDefinition {
  id: string;
  /** Short, because it sits under an icon on a narrow phone. */
  label: string;
  icon: ReactNode;
  /** Omit for tabs everyone can see. */
  requires?: Permission;
  /** Sentence used in onboarding and the help sheet. */
  description: string;
}

export const TABS: TabDefinition[] = [
  {
    id: 'sell-stack',
    label: 'Sell',
    icon: <ReceiptIcon size="1.4em" />,
    requires: 'sales.record',
    description: 'Record what you sell, to whom, and whether they paid.',
  },
  {
    id: 'stock-stack',
    label: 'Stock',
    icon: <BoxIcon size="1.4em" />,
    description: 'What you have, what it cost, and what came in.',
  },
  /*
   * COUNT AND PEOPLE ARE NO LONGER TABS.
   *
   * Six tabs on a 390px phone is six labels of about nine characters, and two of them were earning
   * their place far less than the rest:
   *
   *   COUNT is something you do TO stock, weekly in most shops, beside four things done hourly. It
   *   is reached from the stock screen by a floating button — the same gesture as Take payment on
   *   the till, and the one control on this site that legitimately floats, because it leads
   *   somewhere else rather than committing the page it sits on.
   *
   *   PEOPLE was a list somebody opens to look somebody up: a reference, not a job. Every way INTO
   *   a customer that matters is already elsewhere — the till attaches one, Money lists who owes, a
   *   receipt names one — so the list itself sits under Settings with the other things a shop keeps
   *   rather than does.
   *
   * Neither page moved and neither lost a route; they are secondary pages of `stock-stack` and
   * `settings-stack` now, with a back arrow like every other secondary page.
   */
  {
    id: 'money-stack',
    label: 'Money',
    icon: <CashIcon size="1.4em" />,
    description: 'Who owes you, who you owe, and what has been paid.',
  },
  {
    id: 'settings-stack',
    label: 'More',
    icon: <SettingsIcon size="1.4em" />,
    // No `requires`: everyone can open it. What they can CHANGE is gated inside, and the
    // sign-out control has to be reachable by every role.
    description: 'Printer, receipts, bank details, and your account.',
  },
];

/** The tab a user lands on, respecting what they are allowed to see. */
export function defaultTabFor(allowed: TabDefinition[]): string {
  return allowed[0]?.id ?? 'stock-stack';
}
