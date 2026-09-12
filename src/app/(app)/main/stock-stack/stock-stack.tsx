'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import StockPage from './stock-page/stock-page';
import ReceivePage from './receive-page/receive-page';
import ProductPage from './product-page/product-page';
import StockHistoryPage from './stock-history-page/stock-history-page';
import ProductFormPage from './product-form-page/product-form-page';
import UnitsPage from './units-page/units-page';
/*
 * What a pool comes back in.
 *
 * Registered on the stock stack because it is reached from a product — the moment a shop thinks
 * about crates is the moment it is looking at the beer, not a settings screen it never opens.
 */
import UnitFormPage from './unit-form-page/unit-form-page';
import ShapePricePage from './shape-price-page/shape-price-page';
import SupplierFormPage from './supplier-form-page/supplier-form-page';
import SuppliersPage from './suppliers-page/suppliers-page';
import ExpiryPage from './expiry-page/expiry-page';
/*
 * COUNTING LIVES HERE NOW.
 *
 * It had its own tab and its own stack, which put a job most shops do weekly beside the four they
 * do hourly — and a nav bar is worth more than that. Counting is something you do TO stock, so it
 * is reached from the stock screen by a floating button, the way Take payment is reached from the
 * till, and its pages are secondary pages of this stack with a back button like every other.
 *
 * The files stay under `count-stack/` on purpose: a NavigationStack is a registration, not a
 * folder, and moving eight directories to make the path agree with the map would be churn with
 * real risk and no behaviour attached.
 */
import CountPage from '../count-stack/count-page/count-page';
import CountEntryPage from '../count-stack/count-entry-page/count-entry-page';
import YardPage from '../count-stack/yard-page/yard-page';
import YardCountPage from '../count-stack/yard-count-page/yard-count-page';
import SupplierAccountPage from './supplier-account-page/supplier-account-page';
import SupplierPaymentPage from './supplier-payment-page/supplier-payment-page';
import GroupFormPage from './group-form-page/group-form-page';
/*
 * The receipt, registered here too.
 *
 * A product's history says "Sold, 3" and the next question is always "to whom, on what receipt?".
 * The answer is one join away and the screen would not take you there — so the receipt is
 * reachable from the item, rather than by remembering a date and hunting the sales list.
 *
 * Same component, same route key, reached from a third stack: the pattern the product form
 * already uses between Stock and Sell.
 */
import ReceiptPage from '../sell-stack/receipt-page/receipt-page';
import AmendPage from '../sell-stack/amend-page/amend-page';
import CustomerFormPage from '../people-stack/customer-form-page/customer-form-page';

const navLink = {
  stock_page: StockPage,
  receive_page: ReceivePage,
  product_page: ProductPage,
  stock_history_page: StockHistoryPage,
  product_form_page: ProductFormPage,
  units_page: UnitsPage,
  unit_form_page: UnitFormPage,
  shape_price_page: ShapePricePage,
  supplier_form_page: SupplierFormPage,
  suppliers_page: SuppliersPage,
  expiry_page: ExpiryPage,
  count_page: CountPage,
  count_entry_page: CountEntryPage,
  yard_page: YardPage,
  yard_count_page: YardCountPage,
  supplier_account_page: SupplierAccountPage,
  supplier_payment_page: SupplierPaymentPage,
  group_form_page: GroupFormPage,
  receipt_page: ReceiptPage,
  // Pushed from the receipt, so it is registered wherever the receipt is.
  amend_page: AmendPage,
  // The correction offers to name a walk-in, and pushes the real form to do it.
  customer_form_page: CustomerFormPage,
};

export const StockStack = () => (
  <NavigationStack
    id="stock-stack"
    navLink={navLink}
    entry="stock_page"
    transition="slide"
    syncHistory
    persist
  />
);
