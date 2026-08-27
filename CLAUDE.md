# store-manager

**Read [INSTRUCTIONS.md](INSTRUCTIONS.md) before writing code.** It carries the full rules and,
more importantly, the bug behind each one. What follows is only the part that must not be got
wrong even by a session that reads nothing else.

## The two hard rules

1. **state-stack is the state management tool.** Fetched data does not live in `useState`.
   `useDemandState` from `@academix-admin/state-stack`, with a `key` and a `scope`.
2. **`nav.push` carries an id and a navigation intent. Never a record.** Records travel through
   `nav.provideObject` / `useObject` — always with a database fallback, because `isProvided` is
   false on a cold start and a deep link.

## The traps that have actually cost time

- **One key = one hook = one shape.** Two `useDemandState` calls on one key with different value
  shapes is a data race invisible to `tsc`. It white-screened the bank page. If two screens want
  the same data, hoist one owning hook into `src/lib/stacks/`.
- **A loader must never blank before it fetches.** Pushed-under pages stay mounted, so a page
  returning from a push has not remounted — a blank on the way back is a loader clearing state,
  not a lost `useState`. On a failed refresh, keep the cached value and set only `error`.
- **No polling.** A write invalidates a scope (`accountsChanged()`, `catalogChanged()`,
  `settingsChanged()`); `usePageLifecycle`'s `onResume` reloads.
- **`ttl` deletes live state**, it does not mark it stale. Keep it off data caches.
- **A form is a page. A choice is a sheet.**
- **The Library Charter:** `@academix-admin/*` packages are public-first, app-agnostic and
  non-breaking. A package never learns about store-manager.

## Verification

Click-through with Playwright is the standard of proof — `tsc` passing is not evidence a screen
works. Probes are `scripts/probe-*.mjs`, dev server on port 3100. Write probes that can actually
fail: mutation-test them by removing the fix. See INSTRUCTIONS.md §6 for the harness traps.

Before saying it is done: `npx tsc --noEmit`, `npx next lint`, `npx next build`, and the probes
for the areas touched.
