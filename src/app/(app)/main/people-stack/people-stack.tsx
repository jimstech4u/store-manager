'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import PeoplePage from './people-page/people-page';

const navLink = {
  people_page: PeoplePage,
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
