'use strict';

/**
 * Mirrors electron/database/phoneUtils.js - same normalization rules,
 * duplicated by hand because this file runs in the renderer (ESM,
 * bundled by Vite) while the main-process copy runs in Node (CommonJS).
 * Used by New Order's phone field, the customer search modal, and the
 * dev-mode mock backend in posApi.js, so all three agree on what
 * counts as "the same number" and "a complete number" without ever
 * needing an IPC round-trip just to validate as-you-type input.
 *
 * Keep any change to the matching rules in sync with the electron/
 * copy - see the extended comment there for the accepted raw shapes.
 */
export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.startsWith('0092') && digits.length === 14) return '92' + digits.slice(4);
  if (digits.startsWith('92') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 11) return '92' + digits.slice(1);
  if (digits.length === 10) return '92' + digits;
  return digits;
}

export function isCompletePhoneNumber(raw) {
  const digits = String(raw || '').replace(/\D+/g, '');
  return (
    digits.length === 10 ||
    (digits.length === 11 && digits.startsWith('0')) ||
    (digits.length === 12 && digits.startsWith('92')) ||
    (digits.length === 14 && digits.startsWith('0092'))
  );
}
