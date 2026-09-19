import type { Role } from '@/providers/AuthProvider';

/**
 * Permissions, mirroring the `role_permissions` table.
 *
 * This is a UI convenience ONLY. The database is the authority: every mutating RPC re-checks
 * `has_permission()` server-side, and RLS refuses the write regardless of what the client
 * believed. Nothing here can grant anything — it exists so the interface does not offer a
 * button that will fail, which is a worse experience than not showing it.
 *
 * The improvement over academix-web is the shape rather than the idea. There, role checks were
 * written inline as conditions at each call site, so the answer to "what can a manager actually
 * do?" was spread across the codebase and could drift from the server's view silently. Here the
 * matrix is one table that reads like the SQL it mirrors, so a mismatch is visible by comparison
 * rather than by hunting.
 */

export const PERMISSIONS = [
  'store.settings',
  'staff.manage',
  'products.manage',
  'stock.receive',
  'stock.count',
  'stock.adjust',
  'variance.resolve',
  'period.reopen',
  'sales.record',
  'sales.amend',
  'payments.record',
  'customers.manage',
  'customers.merge',
  'deposits.manage',
  'records.confirm',
  'backfill.manage',
  'reports.view',
  /*
   * Charge a staff member for missing stock or cash, and settle it (0129).
   *
   * Owner and manager only, deliberately, and for the same reason `variance.resolve` is: the
   * person who can make stock disappear must not also be the person who decides who pays for it.
   */
  'staff.charge',
  /*
   * Record money the shop spends — rent, fuel, transport, wages (0137).
   *
   * Owner and manager. A seller who may take a payment has no reason to record the rent, and
   * reading what the shop spends is gated harder still: `expenses` is readable behind
   * `reports.view`, because what a business spends is the owner's business.
   */
  'expenses.record',
  /*
   * Change a shelf count after it has been entered (0145).
   *
   * A day's count is said once. Owner and manager may correct it, with a reason, and the change is
   * kept beside the original — for the same reason as `variance.resolve`.
   */
  'counts.correct',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Keep in step with migrations 0001 and 0029. Staff deliberately cannot resolve a variance: the person who
 * can make stock disappear must not also be the person who explains it away.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,

  manager: [
    'products.manage',
    'stock.receive',
    'stock.count',
    'stock.adjust',
    'variance.resolve',
    'sales.record',
    'sales.amend',
    'payments.record',
    'customers.manage',
    'deposits.manage',
    'records.confirm',
    'reports.view',
    'staff.charge',
    'expenses.record',
    'counts.correct',
  ],

  // Staff deliberately lack records.confirm: they can create a product or customer mid-sale so
  // nobody waits, but signing off their own work would make the review step a formality — the
  // exact bug that reusing customers.manage for confirmation produced.
  staff: [
    'sales.record',
    'payments.record',
    'stock.adjust',
    'customers.manage',
    'deposits.manage',
  ],
};

/**
 * WHAT OPENING EACH PAGE NEEDS — the permission the server checks for that page's job.
 *
 * One map, read in three places, so a person never meets a door they cannot open:
 *   * a button, header action or name link that leads here is not drawn (`canOpen`);
 *   * the page itself, reached anyway (an old link, a URL), says so under its one header;
 *   * and the server refuses regardless — this map only saves somebody the walk.
 *
 * Each entry is the permission the page's own write checks in the database (`has_permission`), not
 * a guess: counting the yard is `deposits.manage` because `count_empties` asks for it, and naming a
 * variance reason is `stock.count` because `add_variance_reason` does. Pages absent from here are
 * open to every member.
 */
export const ROUTE_NEEDS: Readonly<Record<string, Permission>> = {
  count_page: 'stock.count',
  count_entry_page: 'stock.count',
  count_again_page: 'counts.correct',
  variance_reason_page: 'stock.count',
  yard_count_page: 'deposits.manage',
  reports_page: 'reports.view',
  review_page: 'records.confirm',
  staff_page: 'staff.manage',
  staff_invite_page: 'staff.manage',
  staff_charges_page: 'staff.charge',
  words_page: 'products.manage',
  shop_page: 'store.settings',
  bank_form_page: 'store.settings',
  receive_page: 'stock.receive',
  suppliers_page: 'stock.receive',
  supplier_form_page: 'stock.receive',
  supplier_account_page: 'stock.receive',
  supplier_payment_page: 'stock.receive',
  product_form_page: 'products.manage',
  units_page: 'products.manage',
  unit_form_page: 'products.manage',
  group_form_page: 'products.manage',
  shape_price_page: 'products.manage',
  expense_page: 'expenses.record',
  amend_page: 'sales.amend',
  account_action_page: 'payments.record',
  deposit_move_page: 'deposits.manage',
  empties_record_page: 'deposits.manage',
  customer_form_page: 'customers.manage',
};

export function roleCan(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function permissionsFor(role: Role | null | undefined): readonly Permission[] {
  if (!role) return [];
  return ROLE_PERMISSIONS[role] ?? [];
}

/** Plain-language role names, for anywhere a role is shown to a person. */
export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  manager: 'Manager',
  staff: 'Staff',
};

/**
 * What a role is for, in a sentence.
 *
 * Shown when assigning someone a role. "Manager" means nothing on its own, and picking the wrong
 * one is how a shop ends up with everybody an owner — which defeats the separation that makes
 * variance detection meaningful in the first place.
 */
export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: 'Can do everything, including settings, staff and reopening a closed day.',
  manager: 'Runs the shop day to day: stock, sales, prices, and explaining stock differences.',
  staff: 'Sells, takes payment, records damage. Cannot explain away a stock difference.',
};
