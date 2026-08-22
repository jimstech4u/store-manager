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
