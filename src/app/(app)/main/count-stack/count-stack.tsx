'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import CountPage from './count-page/count-page';

const navLink = {
  count_page: CountPage,
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
