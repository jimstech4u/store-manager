'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import SellPage from './sell-page/sell-page';
import ClaimPage from './claim-page/claim-page';
import ShareWhatsAppPage from './share-whatsapp-page/share-whatsapp-page';
import ReceiptPage from './receipt-page/receipt-page';
import TakePaymentPage from './take-payment-page/take-payment-page';
/*
 * What is still out, receipt by receipt.
 *
 * On the SELL stack because that is where the question arrives: a man walks up to the counter with
 * crates in his hands while a sale is half-built, and the shop needs the stack they belong to
 * without leaving the till.
 */
import EmptiesPage from './empties-page/empties-page';
import EmptiesSettlePage from './empties-settle-page/empties-settle-page';
/*
 * The catalogue form, registered in this stack too.
 *
 * A seller asked for something the shop has never entered adds it WITHOUT leaving the receipt, so
 * the form has to be pushable here. Same component, same route key: one form, reached from two
 * stacks, rather than a second nearly-identical one living in sell-stack.
 */
import ProductFormPage from '../stock-stack/product-form-page/product-form-page';
/*
 * And the unit form, because the product form offers to push it.
 *
 * A seller adding something the shop measures in a word it has never used — "sachet", "keg" — is
 * offered a way to invent it, and without this that offer led to navigation-stack's unknown-page
 * screen. A route registered in one stack and not another is a dead end that only appears on the
 * journey nobody tested.
 */
import UnitFormPage from '../stock-stack/unit-form-page/unit-form-page';
/*
 * The sales list, registered here too, for the same reason.
 *
 * The till's header action opens what has already been sold. Reaching it by jumping to the money
 * tab would move the whole app out from under a seller mid-sale and leave them to find their way
 * back; pushing it onto THIS stack means one tap back is the receipt they were building.
 */
import SalesPage from '../money-stack/sales-page/sales-page';
/*
 * The customer form, registered here as well.
 *
 * A seller who needs to put money on account for somebody the shop has never recorded
 * must be able to add them WITHOUT leaving the receipt they are building. Same component,
 * same route key, reached from two stacks — the pattern the product form already uses.
 */
import CustomerFormPage from '../people-stack/customer-form-page/customer-form-page';

const navLink = {
  sell_page: SellPage,
  claim_page: ClaimPage,
  share_whatsapp_page: ShareWhatsAppPage,
  receipt_page: ReceiptPage,
  take_payment_page: TakePaymentPage,
  empties_page: EmptiesPage,
  empties_settle_page: EmptiesSettlePage,
  product_form_page: ProductFormPage,
  unit_form_page: UnitFormPage,
  sales_page: SalesPage,
  customer_form_page: CustomerFormPage,
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
