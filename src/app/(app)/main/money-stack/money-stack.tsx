'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import MoneyPage from './money-page/money-page';

const navLink = {
  money_page: MoneyPage,
};

export const MoneyStack = () => (
  <NavigationStack
    id="money-stack"
    navLink={navLink}
    entry="money_page"
    transition="slide"
    syncHistory
    persist
  />
);
