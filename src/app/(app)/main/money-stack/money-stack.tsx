'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import MoneyPage from './money-page/money-page';
import { RECORD_LINKS, tabRoutes } from '../record-pages';

/*
 * The tab's own front page, then the pages this tab has always had, IN THE ORDER IT HAS ALWAYS HAD
 * THEM — the URL names a route by its position in this list, so reordering it would send a URL
 * already open in somebody's browser to a different page. Every other page arrives through
 * `additionalNavLinks` (`record-pages.tsx`) after these, so each record is one push away from any tab.
 */
const navLink = tabRoutes({ money_page: MoneyPage }, [
  'money_page',
  'sales_page',
  'statement_page',
  'receipt_page',
  'amend_page',
  'customer_form_page',
  'reports_page',
  'expenses_page',
  'expense_page',
  'period_page',
  'account_action_page',
]);

export const MoneyStack = () => (
  <NavigationStack
    id="money-stack"
    navLink={navLink}
    additionalNavLinks={RECORD_LINKS}
    entry="money_page"
    transition="slide"
    syncHistory
    persist
  />
);
