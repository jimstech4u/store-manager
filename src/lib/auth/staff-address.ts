/**
 * Does this look like a shop-issued staff login?
 *
 * `.sm` is the suffix every generated namespace ends with, and no real address does. A false
 * positive costs somebody a more helpful error message than they needed; a false negative sends a
 * staff member to a password email that will never arrive.
 *
 * Its own module because both the sign-in screen and the server route need the same answer, and
 * two copies of a rule like this drift.
 */
export function isStaffAddress(value: string) {
  return /@[a-z0-9]+\.sm$/i.test(value.trim());
}
