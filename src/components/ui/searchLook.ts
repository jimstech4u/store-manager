/**
 * THE LOOK OF A SEARCH BOX IN A SHEET — one definition for every picker and search sheet.
 *
 * Each picker used to spell its own colours and padding, and four of them (customers, suppliers,
 * units, the open-tabs search) left the padding out, so their box fell back to the viewer's default:
 * a tall grey slab beside the compact box every other search had. Spread this into `searchProp`.
 */
export function searchLook(dark: boolean) {
  return {
    background: dark ? '#1b2322' : '#eef2f1',
    textColor: dark ? '#f2f5f4' : '#12201d',
    padding: { l: '4px', r: '4px', t: '0px', b: '0px' },
  };
}
