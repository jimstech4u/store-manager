'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import StockPage from './stock-page/stock-page';
import ReceivePage from './receive-page/receive-page';
import ProductPage from './product-page/product-page';
import StockHistoryPage from './stock-history-page/stock-history-page';
import ProductFormPage from './product-form-page/product-form-page';
import UnitsPage from './units-page/units-page';
import UnitFormPage from './unit-form-page/unit-form-page';
/*
 * The receipt, registered here too.
 *
 * A product's history says "Sold, 3" and the next question is always "to whom, on what receipt?".
 * The answer is one join away and the screen would not take you there — so the receipt is
 * reachable from the item, rather than by remembering a date and hunting the sales list.
 *
 * Same component, same route key, reached from a third stack: the pattern the product form
 * already uses between Stock and Sell.
 */
import ReceiptPage from '../sell-stack/receipt-page/receipt-page';

const navLink = {
  stock_page: StockPage,
  receive_page: ReceivePage,
  product_page: ProductPage,
  stock_history_page: StockHistoryPage,
  product_form_page: ProductFormPage,
  units_page: UnitsPage,
  unit_form_page: UnitFormPage,
  receipt_page: ReceiptPage,
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
