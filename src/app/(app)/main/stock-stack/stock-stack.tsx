'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import StockPage from './stock-page/stock-page';
import { RECORD_LINKS, tabRoutes } from '../record-pages';

/*
 * The tab's own front page, then the pages this tab has always had, IN THE ORDER IT HAS ALWAYS HAD
 * THEM — the URL names a route by its position in this list, so reordering it would send a URL
 * already open in somebody's browser to a different page. Every other page arrives through
 * `additionalNavLinks` (`record-pages.tsx`) after these, so each record is one push away from any tab.
 */
const navLink = tabRoutes({ stock_page: StockPage }, [
  'stock_page',
  'receive_page',
  'product_page',
  'stock_history_page',
  'product_form_page',
  'units_page',
  'unit_form_page',
  'shape_price_page',
  'supplier_form_page',
  'suppliers_page',
  'expiry_page',
  'count_page',
  'count_entry_page',
  'count_again_page',
  'variance_reason_page',
  'yard_page',
  'yard_count_page',
  'supplier_account_page',
  'supplier_payment_page',
  'group_form_page',
  'receipt_page',
  'amend_page',
  'customer_form_page',
]);

export const StockStack = () => (
  <NavigationStack
    id="stock-stack"
    navLink={navLink}
    additionalNavLinks={RECORD_LINKS}
    entry="stock_page"
    transition="slide"
    syncHistory
    persist
  />
);
