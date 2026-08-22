'use client';

import { useCallback, useMemo } from 'react';
import { useAuth } from '@/providers/AuthProvider';
import { roleCan, type Permission } from '@/lib/permissions';

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

  const can = useCallback((permission: Permission) => roleCan(role, permission), [role]);

  return useMemo(() => ({ can, role }), [can, role]);
}
