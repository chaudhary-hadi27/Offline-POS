'use strict';

/**
 * Screen-side copy of the WhatsApp sending-speed rules. The REAL rules live in
 * electron/whatsapp/timing.js (and are enforced there); this copy only drives the Settings form.
 * qa/whatsapp-timing-qa.js fails if the two ever drift apart.
 */
export const SAFE = {
  contact: { min: 8, max: 25 }, // seconds between customers
  group: { min: 6, max: 15 }, // minutes between groups of 15
};
export const LIMITS = {
  contact: { min: 3, max: 120 },
  group: { min: 1, max: 60 },
};
export const PROFILES = [
  { id: 'very-safe', label: 'Very safe', note: 'Slowest. Safest.', contactMin: 20, contactMax: 45, groupMin: 15, groupMax: 30 },
  { id: 'safe', label: 'Safe', note: 'Slower. Very low risk.', contactMin: 12, contactMax: 35, groupMin: 10, groupMax: 20 },
  { id: 'optimized', label: 'Optimized', note: 'Best balance of speed and safety.', contactMin: 8, contactMax: 25, groupMin: 6, groupMax: 15 },
  { id: 'fast', label: 'Fast', note: 'Some risk of a block.', contactMin: 6, contactMax: 16, groupMin: 4, groupMax: 10 },
  { id: 'faster', label: 'Faster', note: 'High risk of a block.', contactMin: 5, contactMax: 12, groupMin: 3, groupMax: 7 },
  { id: 'very-fast', label: 'Very fast', note: 'Very high risk.', contactMin: 4, contactMax: 8, groupMin: 2, groupMax: 4 },
  { id: 'maximum', label: 'Maximum', note: 'Highest risk.', contactMin: 3, contactMax: 5, groupMin: 1, groupMax: 2 },
];
export const DEFAULT_PROFILE_INDEX = 2;

/** Which slider stop matches these four numbers exactly? -1 = custom numbers. */
export function profileIndexOf(v) {
  return PROFILES.findIndex((p) => p.contactMin === v.contactMin && p.contactMax === v.contactMax && p.groupMin === v.groupMin && p.groupMax === v.groupMax);
}

export const KEYS = {
  custom: 'whatsapp_timing_custom',
  contactMin: 'whatsapp_contact_delay_min_s',
  contactMax: 'whatsapp_contact_delay_max_s',
  groupMin: 'whatsapp_group_delay_min_min',
  groupMax: 'whatsapp_group_delay_max_min',
  ack: 'whatsapp_timing_risk_ack_at',
};
export const RISK_WARNING = 'WhatsApp can block your number if you send this fast. If it happens, it is your responsibility.';

export const isRisky = (v) => v.contactMin < SAFE.contact.min || v.groupMin < SAFE.group.min;

/** Rough total time for N customers (groups of 15) at the average of the chosen waits. */
export function estimateMinutes(customers, v) {
  const groups = Math.ceil(customers / 15);
  const avgContactS = (v.contactMin + v.contactMax) / 2;
  const avgGroupMin = (v.groupMin + v.groupMax) / 2;
  return (customers * avgContactS) / 60 + Math.max(0, groups - 1) * avgGroupMin;
}

export function formatMinutes(m) {
  const total = Math.round(m);
  const h = Math.floor(total / 60);
  const min = total % 60;
  return h > 0 ? `${h} h ${min} min` : `${min} min`;
}

/** Returns an error message, or null when the four numbers are acceptable. */
export function validate(v) {
  const check = (n, range, unit, label) =>
    Number.isInteger(n) && n >= range.min && n <= range.max ? null : `${label} must be a whole number from ${range.min} to ${range.max} ${unit}.`;
  return (
    check(v.contactMin, LIMITS.contact, 'seconds', 'Shortest wait between customers') ||
    check(v.contactMax, LIMITS.contact, 'seconds', 'Longest wait between customers') ||
    check(v.groupMin, LIMITS.group, 'minutes', 'Shortest wait between groups') ||
    check(v.groupMax, LIMITS.group, 'minutes', 'Longest wait between groups') ||
    (v.contactMax < v.contactMin ? 'The longest wait between customers cannot be shorter than the shortest wait.' : null) ||
    (v.groupMax < v.groupMin ? 'The longest wait between groups cannot be shorter than the shortest wait.' : null)
  );
}
