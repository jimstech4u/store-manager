'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import PeoplePage from './people-page/people-page';
import AccountPage from './account-page/account-page';

const navLink = {
  people_page: PeoplePage,
  account_page: AccountPage,
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
