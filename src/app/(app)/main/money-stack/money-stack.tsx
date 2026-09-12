'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import MoneyPage from './money-page/money-page';
import SalesPage from './sales-page/sales-page';
import StatementPage from './statement-page/statement-page';
import ReportsPage from './reports-page/reports-page';
/*
 * MONEY GOING OUT — the other half of "how did we do".
 *
 * Every way money could leave was attached to something the shop bought or somebody it owed, so
 * takings read as profit. Reached from a floating pill on the money screen, the way Take payment is
 * reached from the till and Count from Stock.
 */
import ExpensesPage from './expenses-page/expenses-page';
import ExpensePage from './expense-page/expense-page';
// The same receipt screen the sell stack pushes. Registered here too so a past receipt opens
// inside Money's own stack, keeping its back button pointing at the sales list.
import ReceiptPage from '../sell-stack/receipt-page/receipt-page';
import AmendPage from '../sell-stack/amend-page/amend-page';
import CustomerFormPage from '../people-stack/customer-form-page/customer-form-page';
/*
 * The same "record a payment" form the People tab pushes.
 *
 * Recording a payment against a statement was a second implementation of this — its own sheet, its
 * own amount field, its own method buttons, its own call to `record_payment`. Two forms for one
 * job drift: this one never grew the reference field or the bank-account choice the other has.
 */
import AccountActionPage from '../people-stack/account-action-page/account-action-page';

const navLink = {
  money_page: MoneyPage,
  sales_page: SalesPage,
  statement_page: StatementPage,
  receipt_page: ReceiptPage,
  // Pushed from the receipt, so it is registered wherever the receipt is.
  amend_page: AmendPage,
  // The correction offers to name a walk-in, and pushes the real form to do it.
  customer_form_page: CustomerFormPage,
  reports_page: ReportsPage,
  expenses_page: ExpensesPage,
  expense_page: ExpensePage,
  account_action_page: AccountActionPage,
};

export const MoneyStack = () => (
  <NavigationStack
    id="money-stack"
    navLink={navLink}
    entry="money_page"
    transition="slide"
    syncHistory
    persist
  />
);
