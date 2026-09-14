'use strict';

/**
 * Normalizes any Pakistani mobile number a cashier might type into the
 * canonical shape used for matching/uniqueness: '92' + 10 digits
 * (12 digits total - no '+', no spaces/dashes/brackets).
 *
 * Accepted raw shapes (after stripping every non-digit character):
 *   0092XXXXXXXXXX  (00 + country code + 10 digits -> 14 digits)
 *   92XXXXXXXXXX    (country code + 10 digits -> 12 digits, already canonical)
 *   0XXXXXXXXXX     (leading 0 + 10 digits -> 11 digits, e.g. 0300...)
 *   XXXXXXXXXX      (bare 10 digits, no 0/92 -> e.g. 300...)
 *
 * Anything that doesn't match one of those shapes falls back to the
 * stripped-digits string as-is, so an unusual/foreign number is never
 * silently dropped - it just won't get the '92' rewrite applied, and
 * still gets a stable, comparable value for the UNIQUE constraint.
 *
 * Mirrored (by hand, same logic) in src/shell/phoneUtils.js for the
 * renderer/dev-mock side - see the comment there.
 */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.startsWith('0092') && digits.length === 14) return '92' + digits.slice(4);
  if (digits.startsWith('92') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 11) return '92' + digits.slice(1);
  if (digits.length === 10) return '92' + digits;
  return digits;
}

/**
 * True once `raw` holds a COMPLETE phone number in any of the shapes
 * normalizePhone() understands - used to gate "auto-import" UI (New
 * Order's customer-match suggestion, the customer search modal) so it
 * only fires once there's a real number to match, not on every
 * keystroke. The base case is the plain 10-digit local number (e.g.
 * "3001234567"); 0300.../92.../0092... are also recognized as complete.
 */
function isCompletePhoneNumber(raw) {
  const digits = String(raw || '').replace(/\D+/g, '');
  return (
    digits.length === 10 ||
    (digits.length === 11 && digits.startsWith('0')) ||
    (digits.length === 12 && digits.startsWith('92')) ||
    (digits.length === 14 && digits.startsWith('0092'))
  );
}

module.exports = { normalizePhone, isCompletePhoneNumber };
