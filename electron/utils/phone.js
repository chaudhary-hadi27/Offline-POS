'use strict';

/**
 * Canonicalizes any phone number format down to "92" + the bare
 * subscriber number, so things like "0300 1234567", "0300-1234567",
 * "+92 300 1234567", "923001234567", and "00923001234567" all
 * normalize to the same value ("923001234567") instead of each
 * variant creating a separate customer profile.
 *
 * Used for MATCHING only (findByNormalizedPhone, the New Order
 * "known number" auto-fill, and duplicate-customer detection) - the
 * customer's `phone` column keeps whatever format the cashier
 * actually typed, for display on receipts/profiles.
 */
function normalizePhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D+/g, '');
  if (!digits) return '';

  // Peel off (in order) an international "00" prefix, a "92" country
  // code, and a local trunk "0" - whichever is present - so every
  // format converges on the bare subscriber number before the
  // canonical "92" is re-added.
  digits = digits.replace(/^0092/, '').replace(/^92/, '').replace(/^0/, '');

  return digits ? `92${digits}` : '';
}

module.exports = { normalizePhone };
