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

// Registered here as well as in the sell stack, because the account page pushes both. A route
// registered in only one of the stacks that can reach it is navigation-stack's "Missing route"
// screen, on the one journey nobody walked.
import EmptiesCustomerPage from '../sell-stack/empties-customer-page/empties-customer-page';
import DepositCustomerPage from '../sell-stack/deposit-customer-page/deposit-customer-page';
import EmptiesRecordPage from '../sell-stack/empties-record-page/empties-record-page';
import DepositMovePage from '../sell-stack/deposit-move-page/deposit-move-page';

const navLink = {
  receipt_page: ReceiptPage,
  customer_form_page: CustomerFormPage,
  people_page: PeoplePage,
  account_page: AccountPage,
  account_action_page: AccountActionPage,
  empties_customer_page: EmptiesCustomerPage,
  deposit_customer_page: DepositCustomerPage,
  empties_record_page: EmptiesRecordPage,
  deposit_move_page: DepositMovePage,
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
