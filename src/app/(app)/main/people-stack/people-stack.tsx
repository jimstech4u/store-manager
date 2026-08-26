'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import PeoplePage from './people-page/people-page';
import AccountPage from './account-page/account-page';
import AccountActionPage from './account-action-page/account-action-page';

const navLink = {
  people_page: PeoplePage,
  account_page: AccountPage,
  account_action_page: AccountActionPage,
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
