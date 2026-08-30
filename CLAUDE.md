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

## The library comes first

`@academix-admin/*` is not a folder of helpers to reach past. Before building anything that looks
like a sheet, a picker, a list, a dialog or a nav surface:

1. **Read what the package already does.** Its source and its README, not a guess from the name.
   Most of what gets hand-rolled here already exists — `selection-viewer` brings its own search
   box, and a second one was built on top of it before anybody looked.
2. **Use it.** The site uses `selection-viewer`, `search-viewer`, `bottom-viewer` and
   `dialog-viewer`. A hand-made bottom sheet is a bug, not a shortcut.
3. **If the capability is missing, or the package is wrong, FIX THE PACKAGE.** Not a wrapper, not
   a copy, not a `!important` in app CSS reaching into the package's DOM. Make the change
   non-breaking — additive props with defaults that preserve today's behaviour — then publish it,
   then depend on the published version. A patch in the app is only acceptable when a library fix
   is genuinely impossible without breaking the library.
4. **A package never learns about store-manager.** That is the Library Charter, and it is what
   makes 2 and 3 safe to do.

## One composer, not a wall of boxes

A list of things the user adds — fees on a delivery, payments on a sale, charges on an order — is
**one set of inputs and an Add button**, with what has been added listed above it. Never a fixed
row of boxes per possible kind: nobody can name every fee a load might carry, and a screen that
tries has ten empty fields on it for the nine that do not apply this time.

The shop names each one as it adds it. That is also why the fees are stored by name rather than
summed into a total — "loading" and "union levy" mean something to the person reading it back.

## Verification

Click-through with Playwright is the standard of proof — `tsc` passing is not evidence a screen
works. Probes are `scripts/probe-*.mjs`, dev server on port 3100. Write probes that can actually
fail: mutation-test them by removing the fix. See INSTRUCTIONS.md §6 for the harness traps.

Before saying it is done: `npx tsc --noEmit`, `npx next lint`, `npx next build`, and the probes
for the areas touched.
