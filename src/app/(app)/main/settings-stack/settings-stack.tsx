'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import SettingsPage from './settings-page/settings-page';
import { RECORD_LINKS, tabRoutes } from '../record-pages';

/*
 * The tab's own front page, then the pages this tab has always had, IN THE ORDER IT HAS ALWAYS HAD
 * THEM — the URL names a route by its position in this list, so reordering it would send a URL
 * already open in somebody's browser to a different page. Every other page arrives through
 * `additionalNavLinks` (`record-pages.tsx`) after these, so each record is one push away from any tab.
 */
const navLink = tabRoutes({ settings_page: SettingsPage }, [
  'product_form_page',
  'units_page',
  'unit_form_page',
  'group_form_page',
  'customer_form_page',
  'settings_page',
  'shop_page',
  'review_page',
  'staff_page',
  'staff_charges_page',
  'people_page',
  'account_page',
  'account_action_page',
  'receipt_page',
  'amend_page',
  'empties_customer_page',
  'deposit_customer_page',
  'empties_record_page',
  'deposit_move_page',
  'bank_page',
  'words_page',
  'bank_form_page',
  'staff_invite_page',
]);

export const SettingsStack = () => (
  <NavigationStack
    id="settings-stack"
    navLink={navLink}
    additionalNavLinks={RECORD_LINKS}
    entry="settings_page"
    transition="slide"
    syncHistory
    persist
  />
);
