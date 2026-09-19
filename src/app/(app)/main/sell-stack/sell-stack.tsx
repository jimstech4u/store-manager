'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import SellPage from './sell-page/sell-page';
import { RECORD_LINKS, tabRoutes } from '../record-pages';

/*
 * The tab's own front page, then the pages this tab has always had, IN THE ORDER IT HAS ALWAYS HAD
 * THEM — the URL names a route by its position in this list, so reordering it would send a URL
 * already open in somebody's browser to a different page. Every other page arrives through
 * `additionalNavLinks` (`record-pages.tsx`) after these, so each record is one push away from any tab.
 */
const navLink = tabRoutes({ sell_page: SellPage }, [
  'sell_page',
  'claim_page',
  'share_whatsapp_page',
  'receipt_page',
  'amend_page',
  'count_gate_page',
  'count_again_page',
  'take_payment_page',
  'empties_page',
  'empties_customer_page',
  'deposits_page',
  'deposit_customer_page',
  'empties_record_page',
  'deposit_move_page',
  'product_form_page',
  'unit_form_page',
  'group_form_page',
  'sales_page',
  'customer_form_page',
]);

export const SellStack = () => (
  <NavigationStack
    id="sell-stack"
    navLink={navLink}
    additionalNavLinks={RECORD_LINKS}
    entry="sell_page"
    transition="slide"
    syncHistory
    persist
  />
);
