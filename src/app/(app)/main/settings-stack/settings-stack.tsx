'use client';

import NavigationStack from '@academix-admin/navigation-stack';
import SettingsPage from './settings-page/settings-page';
import ReviewPage from './review-page/review-page';
import StaffPage from './staff-page/staff-page';
import BankPage from './bank-page/bank-page';

const navLink = {
  settings_page: SettingsPage,
  review_page: ReviewPage,
  staff_page: StaffPage,
  bank_page: BankPage,
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
