'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import CountPage from './count-page/count-page';
import CountEntryPage from './count-entry-page/count-entry-page';

const navLink = {
  count_page: CountPage,
  count_entry_page: CountEntryPage,
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
