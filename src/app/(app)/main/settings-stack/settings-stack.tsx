'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import SettingsPage from './settings-page/settings-page';
import ReviewPage from './review-page/review-page';

const navLink = {
  settings_page: SettingsPage,
  review_page: ReviewPage,
};

export const SettingsStack = () => (
  <NavigationStack
    id="settings-stack"
    navLink={navLink}
    entry="settings_page"
    transition="slide"
    syncHistory
    persist
  />
);
