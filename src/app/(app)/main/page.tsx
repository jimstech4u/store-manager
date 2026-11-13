'use client';

import { useMemo, useState } from 'react';
import { AppShell, type AppShellTab } from '@academix-admin/app-shell';
import { Logo } from '@/components/ui/Logo';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import { usePermissionsSettled } from '@/providers/PermissionsProvider';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { useLiveShop } from '@/lib/stacks/live-shop';
import { TABS, defaultTabFor } from './nav-config';
import { SellStack } from './sell-stack/sell-stack';
import { StockStack } from './stock-stack/stock-stack';
import { MoneyStack } from './money-stack/money-stack';
import { SettingsStack } from './settings-stack/settings-stack';
import { CustomerHome } from './customer-home';

/**
 * The app shell: one navigation stack per tab, in `@academix-admin/app-shell`.
 *
 *  1. Tabs are filtered by permission before the shell is built, so staff never see a tab that
 *     leads to a screen the database will refuse them.
 *  2. The tab list and its icons live in nav-config.tsx as data.
 *  3. Colours come from the theme's `--ax-shell-*` variables (globals.css), so the bar and the
 *     sidebar follow a mid-session theme switch rather than being handed hard-coded hex values.
 */

/*
 * FOUR STACKS, not six.
 *
 * `count-stack` and `people-stack` are gone as tabs and as stacks: their pages are registered in
 * `stock-stack` and `settings-stack` respectively, reached by a floating button on Stock and a
 * Customers row in Settings. See the note in nav-config.tsx for why.
 */
const STACK_COMPONENTS: Record<string, React.ReactElement> = {
  'sell-stack': <SellStack />,
  'stock-stack': <StockStack />,
  'money-stack': <MoneyStack />,
  'settings-stack': <SettingsStack />,
};

/**
 * NOT DRAWN UNTIL THE PERMISSIONS HAVE ANSWERED (or failed — a dead network still opens the app).
 *
 * The shell picks its first tab once, from the tabs the person may open. Drawn before the server's
 * answer, it picked from the role's stand-in, which can lack `sales.record`: the shop then opened on
 * Stock instead of Sell whenever the answer lost the race (a fresh sign-in, 9 Nov). A cached answer
 * is there at once, so this waits only when there is genuinely nothing to go on.
 */
export default function MainPage() {
  const settled = usePermissionsSettled();
  if (!settled) return <FullPageMessage title="Opening your shop" tone="loading" />;
  return <MainShell />;
}

function MainShell() {
  const { can } = usePermission();
  const { store, user, session, stores } = useAuth();

  /*
   * `/main` IS EVERYONE'S HOME, and they are not all here for the same thing.
   *
   * A shopper gets their own screen: their orders, their basket, a way back to the shops. Below
   * this line is the shop's app — the stacks in a tab group — and none of it means anything to
   * somebody who came to buy a crate of drinks.
   *
   * Read from the session, which is already here, and only believed for somebody with no shop: a
   * shop owner who also shops elsewhere is a shop owner when they open this. `user_metadata` is
   * client-writable, so it decides which of two screens somebody sees and nothing else — every
   * permission is still the database's answer from `auth.uid()`.
   */
  const isShopper =
    stores.length === 0 && session?.user?.user_metadata?.signed_up_as === 'customer';

  // What another till records reaches this one as it happens — see `useLiveShop`. Held for a
  // shopper, who has no till and no shop for it to watch.
  useLiveShop(isShopper ? null : store?.id ?? null, user?.id ?? null);

  /*
   * Tabs are filtered by permission before the shell is built, so staff never see a tab that leads
   * to a screen the database will refuse them. The first tab is decided once, here — so the shell is
   * not drawn until the permissions have answered (MainPage).
   */
  const tabs: AppShellTab[] = useMemo(
    () =>
      TABS.filter((t) => !t.requires || can(t.requires)).map((t) => ({
        id: t.id,
        label: t.label,
        icon: t.icon,
        stack: STACK_COMPONENTS[t.id],
      })),
    [can],
  );
  const [first] = useState(() => defaultTabFor(TABS.filter((t) => !t.requires || can(t.requires))));

  // Their screen, not the shop's. Returned before the shell mounts: stacks a shopper can reach
  // nothing in are stacks' worth of work for a screen they will never see.
  if (isShopper) return <CustomerHome />;

  /*
   * THE SHOP'S APP, IN app-shell (13 Nov). One stack per tab, kept; the tab bar on a phone and the
   * SideBar from 801px, fed the same tabs; the frame sized to what the keyboard leaves and the bar out
   * of the way while typing; tap the open tab for its first page; Back stays in the tab. This used to
   * be 250 lines wired here by hand, the same as JIMSteps', and is now the library's.
   *
   * Colours come from the theme (`--ax-shell-*` in globals.css), so the shell follows a mid-session
   * theme switch without re-rendering. The group id is `main-group`, as before, so a reload keeps
   * every tab where it was.
   */
  return (
    <AppShell
      id="main"
      tabs={tabs}
      defaultActive={first}
      logo={<Logo size={26} />}
      breakpoint={800}
      navigationBar={{
        // 74px against academix-web's 70: the label sits under the icon and this audience needs
        // both to stay legible without crowding the touch target, often one-handed holding goods.
        normalHeight: '74px',
        /*
         * The library's own floating button: a circular action at the left, riding above the bar and
         * staying reachable once the bar hides — tapping it brings the bar back. The sell screen's
         * running total is NOT this: it is our own pill at the other end of the line
         * (`FloatingAmount`, which follows the bar through `useAppShellBar`).
         */
        floatingButton: (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" height="1.5em" width="1.5em" fill="none" aria-hidden="true">
            <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ),
        floatingButtonColor: 'var(--fab-bg)',
      }}
    />
  );
}
