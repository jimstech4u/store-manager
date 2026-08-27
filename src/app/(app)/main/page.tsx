'use client';

import { useMemo, useState } from 'react';
import styles from './page.module.css';
import {
  GroupNavigationStack,
  popStackToRoot,
  scrollBroadcaster,
} from '@academix-admin/navigation-stack';
import NavigationBar from '@academix-admin/navigation-bar';
import { useTheme } from '@/context/ThemeContext';
import { reportNavBarState } from '@/providers/NavBarState';
import { usePermission } from '@/hooks/usePermission';
import { TABS, defaultTabFor } from './nav-config';
import { SellStack } from './sell-stack/sell-stack';
import { StockStack } from './stock-stack/stock-stack';
import { CountStack } from './count-stack/count-stack';
import { MoneyStack } from './money-stack/money-stack';
import { PeopleStack } from './people-stack/people-stack';
import { SettingsStack } from './settings-stack/settings-stack';

/**
 * The app shell: one navigation stack per tab, coordinated by GroupNavigationStack.
 *
 * Same structure academix-web uses, with three differences that came out of its experience:
 *
 *  1. Tabs are filtered by permission before the bar is built, so staff never see a tab that
 *     leads to a screen the database will refuse them.
 *  2. The tab list and its icons live in nav-config.tsx as data. academix-web declares the
 *     equivalent inline here, with each icon as a raw <path>, which buries the actual layout
 *     under ~150 lines of SVG.
 *  3. Colours come from CSS custom properties resolved at render, so the bar follows the theme
 *     (including a mid-session switch) rather than being handed two hard-coded hex values.
 */

const STACK_COMPONENTS: Record<string, React.ReactElement> = {
  'sell-stack': <SellStack />,
  'stock-stack': <StockStack />,
  'count-stack': <CountStack />,
  'money-stack': <MoneyStack />,
  'people-stack': <PeopleStack />,
  'settings-stack': <SettingsStack />,
};

export default function MainShell() {
  const { theme } = useTheme();
  const { can } = usePermission();

  const tabs = useMemo(() => TABS.filter((t) => !t.requires || can(t.requires)), [can]);
  const [active, setActive] = useState(() => defaultTabFor(tabs));

  // A permission change (or a store switch into a lesser role) can remove the tab currently
  // shown. Falling back keeps the shell on something valid instead of rendering an empty frame.
  const activeId = tabs.some((t) => t.id === active) ? active : defaultTabFor(tabs);

  const navStack = useMemo(
    () => new Map(tabs.map((t) => [t.id, STACK_COMPONENTS[t.id]] as const)),
    [tabs],
  );

  const navKeys = useMemo(
    () => tabs.map((t) => ({ id: t.id, text: t.label, svg: t.icon })),
    [tabs],
  );

  const isDark = theme === 'dark';

  return (
    <div className={styles.shell}>
      <div className={styles.stacks}>
        <GroupNavigationStack
          id="main-group"
          current={activeId}
          navStack={navStack}
          onCurrentChange={setActive}
          persist
        />
      </div>

      <div className={styles.navWrap}>
        <NavigationBar
          navKeys={navKeys}
          activeId={activeId}
          onChange={(id) => setActive(id)}
          // Tapping the tab you are already on returns that tab to its first page — the gesture
          // every native tab bar has, and the fastest way out of a stack several pages deep.
          onReselect={(id) => popStackToRoot(id)}
          onScroll={(callback) => scrollBroadcaster.subscribe(callback)}
          /*
           * The bar reports its own state, and the shell publishes it.
           *
           * The sell screen's running total sits at the other end of the bar's line and has to
           * follow it. It used to work that out for itself, which drifted, and then by sniffing
           * the bar's CSS transition, which reached into the library's internals. The bar knows;
           * this asks it.
           */
          onVisibilityChange={reportNavBarState}
          /*
           * `autohide`, the same configuration academix-web uses, colours aside.
           *
           * `float` was tried first and it SHRINKS the bar's height rather than moving it, which
           * with a 0px shrink height collapses the tabs to nothing while scrolling — the tabs
           * vanish in place instead of sliding away, and they are the app's primary navigation.
           * `autohide` slides the whole bar down and brings it straight back on an upward scroll.
           */
          mode="autohide"
          barBorderRadius="16px 16px 0 0"
          barShadow={
            isDark ? '0 -4px 20px rgba(0, 0, 0, 0.4)' : '0 -4px 20px rgba(0, 0, 0, 0.1)'
          }
          className={styles.nav}
          activeColor={isDark ? '#8fcbbe' : '#0b6252'}
          inactiveColor={isDark ? '#a8b3b1' : '#4d5554'}
          hoverColor={isDark ? '#a5d8cb' : '#0f7a66'}
          backgroundColor={isDark ? '#171d1c' : '#ffffff'}
          // 74px against academix-web's 70: the label sits under the icon and this audience needs
          // both to stay legible without crowding the touch target.
          normalHeight="74px"
          shrinkHeight="0px"
          iconSize="22px"
          textSize="12px"
          fontWeight={600}
          itemSpacing="8px"
          paddingY="0px"
          paddingX="0px"
          breakpointSpacing={{ '800': '32px', '500': '24px', '0': '16px' }}
          barBorderTop={`1px solid ${isDark ? '#2a3231' : '#dde1e0'}`}
          /*
           * The library's own floating button, configured as academix-web has it: a circular
           * action at the left, riding above the bar and staying reachable once the bar hides.
           *
           * Tapping it brings the bar back — that behaviour belongs to the package, not to us.
           * It is what makes `autohide` safe on a long page: the tabs can slide away without the
           * navigation ever becoming unreachable.
           *
           * The sell screen's running total is NOT this. That is our own pill at the other end of
           * the same line, because this slot holds one control and the two answer to different
           * things.
           */
          floatingButton={
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              height="1.5em"
              width="1.5em"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M3 6h18M3 12h18M3 18h18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          }
          floatingButtonPosition="left"
          floatingButtonBottom="16px"
          floatingButtonPadding="16px"
          floatingButtonColor={isDark ? '#0f7a66' : '#0b6252'}
          floatingButtonTextColor="#ffffff"
          floatingButtonRadius="50%"
          floatingButtonShadow={
            isDark ? '0 6px 12px rgba(0,0,0,0.4)' : '0 6px 12px rgba(0,0,0,0.25)'
          }
        />
      </div>
    </div>
  );
}
