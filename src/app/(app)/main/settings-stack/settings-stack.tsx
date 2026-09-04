'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import SettingsPage from './settings-page/settings-page';
import ReviewPage from './review-page/review-page';
import StaffPage from './staff-page/staff-page';
import BankPage from './bank-page/bank-page';
import PoolsPage from './pools-page/pools-page';
import BankFormPage from './bank-form-page/bank-form-page';
import StaffInvitePage from './staff-invite-page/staff-invite-page';

/*
 * The catalogue and customer forms, registered here too.
 *
 * A record waiting to be checked is one somebody created mid-sale with the three things a counter
 * had time for. Approving it is only half the job — the other half is FILLING IN THE REST: what it
 * arrives in, what it cost, a cheaper price for buying more. Sending a manager off to the Stock tab
 * to find it by name is how a review queue turns into a list nobody works through.
 *
 * Same components, same route keys, reached from a third stack — the pattern the product form
 * already uses between Stock and Sell.
 */
import ProductFormPage from '../stock-stack/product-form-page/product-form-page';
import UnitsPage from '../stock-stack/units-page/units-page';
import UnitFormPage from '../stock-stack/unit-form-page/unit-form-page';
import CustomerFormPage from '../people-stack/customer-form-page/customer-form-page';

const navLink = {
  product_form_page: ProductFormPage,
  units_page: UnitsPage,
  unit_form_page: UnitFormPage,
  customer_form_page: CustomerFormPage,
  settings_page: SettingsPage,
  review_page: ReviewPage,
  staff_page: StaffPage,
  bank_page: BankPage,
  pools_page: PoolsPage,
  bank_form_page: BankFormPage,
  staff_invite_page: StaffInvitePage,
};

export const SettingsStack = () => (
  <NavigationStack
    id="settings-stack"
    navLink={navLink}
    entry="settings_page"
    transition="slide"
    syncHistory
    persist
  />
);
