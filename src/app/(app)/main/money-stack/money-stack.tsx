'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import MoneyPage from './money-page/money-page';
import SalesPage from './sales-page/sales-page';
// The same receipt screen the sell stack pushes. Registered here too so a past receipt opens
// inside Money's own stack, keeping its back button pointing at the sales list.
import ReceiptPage from '../sell-stack/receipt-page/receipt-page';

const navLink = {
  money_page: MoneyPage,
  sales_page: SalesPage,
  receipt_page: ReceiptPage,
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
