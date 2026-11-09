/**
 * PUTTING SOMETHING ON THE TILL, the way a seller does it now: the one box at the top of the order
 * ("3 b/s"), then the result. Probes written before the box opened the "Add an item" sheet; move
 * them here rather than teaching each one the box.
 *
 *     await addOnTill(page, 'Big Stout', 'Big Stout Bottle (600mL)');      // as it starts
 *     await addOnTill(page, '2 Big Stout', 'Big Stout Bottle (600mL)');    // two of it
 */
export async function addOnTill(page, typed, name) {
  const box = page.getByLabel('Add an item: how many, then what').locator('visible=true').first();
  await box.click();
  await box.fill('');
  // Typed, not filled: the search is debounced off real keystrokes.
  await box.pressSequentially(typed, { delay: 30 });
  const row = page.getByRole('option').filter({ hasText: name }).first();
  await row.waitFor({ timeout: 20000 });
  await row.click();
  // The line lands after its shapes are read.
  await page.getByRole('button', { name: `One more ${name}` }).locator('visible=true').first().waitFor({ timeout: 20000 });
}
