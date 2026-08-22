'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import SellPage from './sell-page/sell-page';

const navLink = {
  sell_page: SellPage,
};

export const SellStack = () => (
  <NavigationStack
    id="sell-stack"
    navLink={navLink}
    entry="sell_page"
    transition="slide"
    syncHistory
    persist
  />
);
