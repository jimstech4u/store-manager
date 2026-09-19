'use client';

import { useCallback, useMemo } from 'react';
import { useAuth } from '@/providers/AuthProvider';
import { ROUTE_NEEDS, roleCan, type Permission } from '@/lib/permissions';
import { useGrantedPermissions } from '@/providers/PermissionsProvider';

/**
 * `can('sales.record')` — the single way the UI asks whether something is allowed.
 *
 * One function, used everywhere, instead of role comparisons written out at each call site.
 * academix-web's equivalent checks were inline (`role === 'admin'` and similar), which meant a
 * permission change had to be found in every place it had been expressed, and a missed one
 * failed silently in the direction that matters — showing an action the server would refuse.
 *
 * The server still decides. This only decides what to render.
 */
export function usePermission() {
  const { store } = useAuth();
  const role = store?.role ?? null;

  // The server's per-person answer once it has arrived; the role until then.
  const granted = useGrantedPermissions();
  const can = useCallback(
    (permission: Permission) => (granted ? granted.has(permission) : roleCan(role, permission)),
    [granted, role],
  );

  // Whether a page can be opened at all — for the button, action or link that would push it.
  const canOpen = useCallback(
    (route: string) => {
      const needs = ROUTE_NEEDS[route];
      return needs ? can(needs) : true;
    },
    [can],
  );

  return useMemo(() => ({ can, canOpen, role }), [can, canOpen, role]);
}
