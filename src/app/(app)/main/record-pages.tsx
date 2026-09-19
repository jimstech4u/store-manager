'use client';

import type { ComponentType } from 'react';
import ProductPage from './stock-stack/product-page/product-page';
import ProductFormPage from './stock-stack/product-form-page/product-form-page';
import ReceivePage from './stock-stack/receive-page/receive-page';
import StockHistoryPage from './stock-stack/stock-history-page/stock-history-page';
import UnitsPage from './stock-stack/units-page/units-page';
import UnitFormPage from './stock-stack/unit-form-page/unit-form-page';
import ShapePricePage from './stock-stack/shape-price-page/shape-price-page';
import GroupFormPage from './stock-stack/group-form-page/group-form-page';
import ExpiryPage from './stock-stack/expiry-page/expiry-page';
import SuppliersPage from './stock-stack/suppliers-page/suppliers-page';
import SupplierFormPage from './stock-stack/supplier-form-page/supplier-form-page';
import SupplierAccountPage from './stock-stack/supplier-account-page/supplier-account-page';
import SupplierPaymentPage from './stock-stack/supplier-payment-page/supplier-payment-page';
import CountPage from './count-stack/count-page/count-page';
import CountEntryPage from './count-stack/count-entry-page/count-entry-page';
import CountAgainPage from './count-stack/count-again-page/count-again-page';
import VarianceReasonPage from './count-stack/variance-reason-page/variance-reason-page';
import YardPage from './count-stack/yard-page/yard-page';
import YardCountPage from './count-stack/yard-count-page/yard-count-page';
import ReceiptPage from './sell-stack/receipt-page/receipt-page';
import AmendPage from './sell-stack/amend-page/amend-page';
import ClaimPage from './sell-stack/claim-page/claim-page';
import ShareWhatsAppPage from './sell-stack/share-whatsapp-page/share-whatsapp-page';
import CountGatePage from './sell-stack/count-gate-page/count-gate-page';
import TakePaymentPage from './sell-stack/take-payment-page/take-payment-page';
import EmptiesPage from './sell-stack/empties-page/empties-page';
import EmptiesCustomerPage from './sell-stack/empties-customer-page/empties-customer-page';
import EmptiesRecordPage from './sell-stack/empties-record-page/empties-record-page';
import DepositsPage from './sell-stack/deposits-page/deposits-page';
import DepositCustomerPage from './sell-stack/deposit-customer-page/deposit-customer-page';
import DepositMovePage from './sell-stack/deposit-move-page/deposit-move-page';
import SalesPage from './money-stack/sales-page/sales-page';
import StatementPage from './money-stack/statement-page/statement-page';
import ReportsPage from './money-stack/reports-page/reports-page';
import ExpensesPage from './money-stack/expenses-page/expenses-page';
import ExpensePage from './money-stack/expense-page/expense-page';
import PeriodPage from './money-stack/period-page/period-page';
import PeoplePage from './people-stack/people-page/people-page';
import AccountPage from './people-stack/account-page/account-page';
import AccountActionPage from './people-stack/account-action-page/account-action-page';
import CustomerFormPage from './people-stack/customer-form-page/customer-form-page';
import ShopPage from './settings-stack/shop-page/shop-page';
import ReviewPage from './settings-stack/review-page/review-page';
import StaffPage from './settings-stack/staff-page/staff-page';
import StaffInvitePage from './settings-stack/staff-invite-page/staff-invite-page';
import StaffChargesPage from './settings-stack/staff-charges-page/staff-charges-page';
import BankPage from './settings-stack/bank-page/bank-page';
import BankFormPage from './settings-stack/bank-form-page/bank-form-page';
import WordsPage from './settings-stack/words-page/words-page';

/**
 * EVERY PAGE THAT IS NOT A TAB'S OWN FRONT PAGE — registered in every tab.
 *
 * «we should be able to push connected (joined) records pages from where we are … to help us have a
 *  single flow state than pressing back all the time»
 *
 * Each tab used to list the pages it could push, and a page was added to a second tab only when
 * somebody found the "Missing route" screen. So a receipt could be opened from Stock but its
 * customer could not, a statement was reachable from Money but not from the customer it belongs
 * to, and following a record to the next one meant going back to the tab that happened to own it.
 *
 * Now a record is one push from wherever it is mentioned, in whichever tab you are in, and the back
 * arrow walks back through exactly what you followed. Each stack keeps only its front page in its
 * own `navLink` (with the pages it always had, in their old order — see `tabRoutes`); the rest arrive
 * through navigation-stack's `additionalNavLinks`.
 *
 * A page added to the app goes HERE, unless it is a tab's front page — and AT THE END of this map:
 * these follow each tab's own list in the URL by position too, so one inserted in the middle would
 * send every open URL for the pages after it somewhere else.
 */
export const RECORD_PAGES: Record<string, ComponentType> = {
  // Stock and what is bought
  product_page: ProductPage,
  product_form_page: ProductFormPage,
  receive_page: ReceivePage,
  stock_history_page: StockHistoryPage,
  units_page: UnitsPage,
  unit_form_page: UnitFormPage,
  shape_price_page: ShapePricePage,
  group_form_page: GroupFormPage,
  expiry_page: ExpiryPage,
  suppliers_page: SuppliersPage,
  supplier_form_page: SupplierFormPage,
  supplier_account_page: SupplierAccountPage,
  supplier_payment_page: SupplierPaymentPage,
  // Counting
  count_page: CountPage,
  count_entry_page: CountEntryPage,
  count_again_page: CountAgainPage,
  variance_reason_page: VarianceReasonPage,
  yard_page: YardPage,
  yard_count_page: YardCountPage,
  // Sales, and what goes out with them
  receipt_page: ReceiptPage,
  amend_page: AmendPage,
  claim_page: ClaimPage,
  share_whatsapp_page: ShareWhatsAppPage,
  count_gate_page: CountGatePage,
  take_payment_page: TakePaymentPage,
  empties_page: EmptiesPage,
  empties_customer_page: EmptiesCustomerPage,
  empties_record_page: EmptiesRecordPage,
  deposits_page: DepositsPage,
  deposit_customer_page: DepositCustomerPage,
  deposit_move_page: DepositMovePage,
  // Money
  sales_page: SalesPage,
  statement_page: StatementPage,
  reports_page: ReportsPage,
  expenses_page: ExpensesPage,
  expense_page: ExpensePage,
  period_page: PeriodPage,
  // People
  people_page: PeoplePage,
  account_page: AccountPage,
  account_action_page: AccountActionPage,
  customer_form_page: CustomerFormPage,
  // The shop
  shop_page: ShopPage,
  review_page: ReviewPage,
  staff_page: StaffPage,
  staff_invite_page: StaffInvitePage,
  staff_charges_page: StaffChargesPage,
  bank_page: BankPage,
  bank_form_page: BankFormPage,
  words_page: WordsPage,
};

/** Handed to each stack's `additionalNavLinks` — one array, so its identity never changes. */
export const RECORD_LINKS = [RECORD_PAGES];

/**
 * A tab's `navLink`, in a FIXED order: its own front page and the record pages it has always
 * registered, in the order they were first registered.
 *
 * navigation-stack writes a route into the URL as its POSITION in the stack's map ("aH" is the
 * 34th). New pages only ever go after these, through `additionalNavLinks`; changing this order
 * would make every URL already open decode to a different page.
 */
export function tabRoutes(
  own: Record<string, ComponentType>,
  order: string[],
): Record<string, ComponentType> {
  const out: Record<string, ComponentType> = {};
  for (const key of order) {
    const page = own[key] ?? RECORD_PAGES[key];
    if (!page) throw new Error(`No page registered as "${key}"`);
    out[key] = page;
  }
  return out;
}
