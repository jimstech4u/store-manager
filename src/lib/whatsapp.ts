/**
 * A phone number as WhatsApp wants it: digits only, with a country code, no leading plus.
 *
 * Nigerian numbers are written locally as `0803 000 0000` and that is what a seller types — but
 * `wa.me` needs `2348030000000`. Getting this wrong opens a chat with nobody, which looks to the
 * seller like the customer has blocked them.
 *
 * Returns null when there is nothing usable, so the caller can say so rather than opening a
 * broken link.
 */
export function toWhatsAppNumber(input: string, defaultCountry = '234'): string | null {
  const digits = (input ?? '').replace(/\D/g, '');
  if (digits.length < 7) return null;

  // Already international, however it was written: +234…, 00234…, or 234….
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith(defaultCountry) && digits.length >= defaultCountry.length + 9) return digits;

  // The local form: a leading 0 stands in for the country code.
  if (digits.startsWith('0')) return `${defaultCountry}${digits.slice(1)}`;

  /*
   * Ten digits with no prefix is the local number with the 0 left off — common when somebody
   * reads it out. Anything longer is assumed to carry its own country code already.
   */
  if (digits.length === 10) return `${defaultCountry}${digits}`;
  return digits;
}
