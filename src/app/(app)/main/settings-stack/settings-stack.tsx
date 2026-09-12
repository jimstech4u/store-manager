'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import SettingsPage from './settings-page/settings-page';
import ReviewPage from './review-page/review-page';
import StaffPage from './staff-page/staff-page';
import StaffChargesPage from './staff-charges-page/staff-charges-page';
/*
 * CUSTOMERS LIVE HERE NOW, as a section of Settings rather than a tab of their own.
 *
 * The People tab was a list somebody opens to look somebody up — a reference, not a job — and it
 * was spending a sixth of the nav bar on that. Every way INTO a customer that matters is already
 * elsewhere: the till attaches one, Money lists who owes, a receipt names one. So the list itself
 * belongs with the other things a shop keeps rather than does.
 *
 * The files stay under `people-stack/`: a NavigationStack is a registration, not a folder.
 */
import PeoplePage from '../people-stack/people-page/people-page';
import AccountPage from '../people-stack/account-page/account-page';
import AccountActionPage from '../people-stack/account-action-page/account-action-page';
import CustomerFormPage from '../people-stack/customer-form-page/customer-form-page';
import ReceiptPage from '../sell-stack/receipt-page/receipt-page';
import AmendPage from '../sell-stack/amend-page/amend-page';
import EmptiesCustomerPage from '../sell-stack/empties-customer-page/empties-customer-page';
import DepositCustomerPage from '../sell-stack/deposit-customer-page/deposit-customer-page';
import EmptiesRecordPage from '../sell-stack/empties-record-page/empties-record-page';
import DepositMovePage from '../sell-stack/deposit-move-page/deposit-move-page';
import BankPage from './bank-page/bank-page';
import WordsPage from './words-page/words-page';
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
import GroupFormPage from '../stock-stack/group-form-page/group-form-page';
import ShopPage from './shop-page/shop-page';

const navLink = {
  product_form_page: ProductFormPage,
  units_page: UnitsPage,
  unit_form_page: UnitFormPage,
  group_form_page: GroupFormPage,
  customer_form_page: CustomerFormPage,
  settings_page: SettingsPage,
  shop_page: ShopPage,
  review_page: ReviewPage,
  staff_page: StaffPage,
  staff_charges_page: StaffChargesPage,
  people_page: PeoplePage,
  account_page: AccountPage,
  account_action_page: AccountActionPage,
  receipt_page: ReceiptPage,
  // Pushed from the receipt, so it is registered wherever the receipt is.
  amend_page: AmendPage,
  empties_customer_page: EmptiesCustomerPage,
  deposit_customer_page: DepositCustomerPage,
  empties_record_page: EmptiesRecordPage,
  deposit_move_page: DepositMovePage,
  bank_page: BankPage,
  words_page: WordsPage,
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
