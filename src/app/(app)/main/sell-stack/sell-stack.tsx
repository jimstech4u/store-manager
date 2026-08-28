'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import SellPage from './sell-page/sell-page';
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

const navLink = {
  sell_page: SellPage,
  receipt_page: ReceiptPage,
  take_payment_page: TakePaymentPage,
  product_form_page: ProductFormPage,
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
