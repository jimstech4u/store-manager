'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import StockPage from './stock-page/stock-page';
import ReceivePage from './receive-page/receive-page';
import ProductPage from './product-page/product-page';
import StockHistoryPage from './stock-history-page/stock-history-page';
import ProductFormPage from './product-form-page/product-form-page';

const navLink = {
  stock_page: StockPage,
  receive_page: ReceivePage,
  product_page: ProductPage,
  stock_history_page: StockHistoryPage,
  product_form_page: ProductFormPage,
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
