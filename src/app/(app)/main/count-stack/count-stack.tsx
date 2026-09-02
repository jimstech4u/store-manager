'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import CountPage from './count-page/count-page';
import CountEntryPage from './count-entry-page/count-entry-page';
/*
 * The catalogue form, registered here too.
 *
 * The commonest thing a count turns up is something nobody ever entered, and the counter has to be
 * able to add it WITHOUT leaving a count half done. Same component, same route key — one form
 * reached from four stacks, which is the pattern sell-stack and stock-stack already use.
 *
 * Missing until now, and the symptom was navigation-stack's own unknown-page screen: tapping the
 * header's + on the count page gave "Missing route: product_form_page". The feedback worked; the
 * wiring did not.
 */
import ProductFormPage from '../stock-stack/product-form-page/product-form-page';
import UnitFormPage from '../stock-stack/unit-form-page/unit-form-page';

const navLink = {
  count_page: CountPage,
  count_entry_page: CountEntryPage,
  product_form_page: ProductFormPage,
  // The form offers to invent a unit the shop has no word for, and pushes it by name.
  unit_form_page: UnitFormPage,
};

export const CountStack = () => (
  <NavigationStack
    id="count-stack"
    navLink={navLink}
    entry="count_page"
    transition="slide"
    syncHistory
    persist
  />
);
