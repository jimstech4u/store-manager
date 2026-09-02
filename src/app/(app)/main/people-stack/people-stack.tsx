'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import CustomerFormPage from './customer-form-page/customer-form-page';
import PeoplePage from './people-page/people-page';
import AccountPage from './account-page/account-page';
import AccountActionPage from './account-action-page/account-action-page';

/*
 * The receipt, registered here too.
 *
 * A customer's account lists what they owe and what they paid; "what was that ₦21,500 for?" is the
 * next question, and its answer is a sale this stack could not reach. Same component, same route
 * key, reached from another stack.
 */
import ReceiptPage from '../sell-stack/receipt-page/receipt-page';

const navLink = {
  receipt_page: ReceiptPage,
  customer_form_page: CustomerFormPage,
  people_page: PeoplePage,
  account_page: AccountPage,
  account_action_page: AccountActionPage,
};

export const PeopleStack = () => (
  <NavigationStack
    id="people-stack"
    navLink={navLink}
    entry="people_page"
    transition="slide"
    syncHistory
    persist
  />
);
