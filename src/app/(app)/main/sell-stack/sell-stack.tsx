'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import SellPage from './sell-page/sell-page';
import ClaimPage from './claim-page/claim-page';
import ReceiptPage from './receipt-page/receipt-page';
import TakePaymentPage from './take-payment-page/take-payment-page';
/*
 * The catalogue form, registered in this stack too.
 *
 * A seller asked for something the shop has never entered adds it WITHOUT leaving the receipt, so
 * the form has to be pushable here. Same component, same route key: one form, reached from two
 * stacks, rather than a second nearly-identical one living in sell-stack.
 */
import ProductFormPage from '../stock-stack/product-form-page/product-form-page';
/*
 * The sales list, registered here too, for the same reason.
 *
 * The till's header action opens what has already been sold. Reaching it by jumping to the money
 * tab would move the whole app out from under a seller mid-sale and leave them to find their way
 * back; pushing it onto THIS stack means one tap back is the receipt they were building.
 */
import SalesPage from '../money-stack/sales-page/sales-page';

const navLink = {
  sell_page: SellPage,
  claim_page: ClaimPage,
  receipt_page: ReceiptPage,
  take_payment_page: TakePaymentPage,
  product_form_page: ProductFormPage,
  sales_page: SalesPage,
};

export const SellStack = () => (
  <NavigationStack
    id="sell-stack"
    navLink={navLink}
    entry="sell_page"
    transition="slide"
    syncHistory
    persist
  />
);
