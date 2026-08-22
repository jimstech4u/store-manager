'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import StockPage from './stock-page/stock-page';
import ReceivePage from './receive-page/receive-page';

const navLink = {
  stock_page: StockPage,
  receive_page: ReceivePage,
};

export const StockStack = () => (
  <NavigationStack
    id="stock-stack"
    navLink={navLink}
    entry="stock_page"
    transition="slide"
    syncHistory
    persist
  />
);
