'use strict';

/**
 * WhatsApp sending speed - the rules, in one place (no Electron, no database: easy to test).
 *
 * Two different boundaries:
 *   SAFE     the recommended speed. Anything as slow as this, or slower, is always fine.
 *            These are also the defaults.
 *   LIMITS   the absolute walls. Nothing outside them is ever accepted or used, whatever is typed
 *            or edited into the settings file.
 *
 * Going FASTER than SAFE (but still inside LIMITS) is allowed only after the owner has ticked the
 * risk confirmation: WhatsApp may restrict or permanently ban a number that sends too fast, and the
 * owner is responsible for that. Without the confirmation the app silently falls back to SAFE speed.
 */

const SAFE = {
  contact: { min: 8, max: 25 }, // seconds between two customers
  group: { min: 6, max: 15 }, // minutes between groups of 15
};
const LIMITS = {
  contact: { min: 3, max: 120 }, // seconds
  group: { min: 1, max: 60 }, // minutes
};

/**
 * The speed slider's stops, slowest -> fastest. Moving the slider just fills in these four numbers.
 * Stops 0-2 are at or slower than SAFE (no confirmation needed); stops 3+ are faster than SAFE (risk confirmation).
 */
const PROFILES = [
  { id: 'very-safe', label: 'Very safe', note: 'Slowest. Safest.', contactMin: 20, contactMax: 45, groupMin: 15, groupMax: 30 },
  { id: 'safe', label: 'Safe', note: 'Slower. Very low risk.', contactMin: 12, contactMax: 35, groupMin: 10, groupMax: 20 },
  { id: 'optimized', label: 'Optimized', note: 'Best balance of speed and safety.', contactMin: 8, contactMax: 25, groupMin: 6, groupMax: 15 },
  { id: 'fast', label: 'Fast', note: 'Some risk of a block.', contactMin: 6, contactMax: 16, groupMin: 4, groupMax: 10 },
  { id: 'faster', label: 'Faster', note: 'High risk of a block.', contactMin: 5, contactMax: 12, groupMin: 3, groupMax: 7 },
  { id: 'very-fast', label: 'Very fast', note: 'Very high risk.', contactMin: 4, contactMax: 8, groupMin: 2, groupMax: 4 },
  { id: 'maximum', label: 'Maximum', note: 'Highest risk.', contactMin: 3, contactMax: 5, groupMin: 1, groupMax: 2 },
];
const DEFAULT_PROFILE_INDEX = 2;

const KEYS = {
  custom: 'whatsapp_timing_custom', // '1' = use the custom values below
  contactMin: 'whatsapp_contact_delay_min_s',
  contactMax: 'whatsapp_contact_delay_max_s',
  groupMin: 'whatsapp_group_delay_min_min',
  groupMax: 'whatsapp_group_delay_max_min',
  ack: 'whatsapp_timing_risk_ack_at', // ISO time the owner accepted the risk (set by the app, not by the screen)
};
const ALL_KEYS = Object.values(KEYS);

const LABELS = {
  [KEYS.contactMin]: 'Shortest wait between customers',
  [KEYS.contactMax]: 'Longest wait between customers',
  [KEYS.groupMin]: 'Shortest wait between groups',
  [KEYS.groupMax]: 'Longest wait between groups',
};
const RANGE_OF = {
  [KEYS.contactMin]: ['contact', 's'],
  [KEYS.contactMax]: ['contact', 's'],
  [KEYS.groupMin]: ['group', 'min'],
  [KEYS.groupMax]: ['group', 'min'],
};

const RISK_WARNING = 'WhatsApp can block your number if you send this fast. If it happens, it is your responsibility.';

const isIntString = (v) => /^\d+$/.test(String(v ?? '').trim());
const toInt = (v) => parseInt(String(v).trim(), 10);

function touchesTimingKeys(entries) {
  return !!entries && typeof entries === 'object' && ALL_KEYS.some((k) => Object.prototype.hasOwnProperty.call(entries, k));
}

/** Is this (min) pair faster than the recommended floor? */
function isRisky({ contactMin, groupMin }) {
  return contactMin < SAFE.contact.min || groupMin < SAFE.group.min;
}

/**
 * Turns the saved settings into the numbers the sender uses. Never throws, never returns anything
 * outside LIMITS, and never uses a risky speed unless the owner confirmed it.
 */
function resolveTiming(settings = {}) {
  const defaults = {
    contactMinMs: SAFE.contact.min * 1000,
    contactMaxMs: SAFE.contact.max * 1000,
    groupMinMs: SAFE.group.min * 60000,
    groupMaxMs: SAFE.group.max * 60000,
  };
  const base = { custom: false, risky: false, acknowledged: false, usingSafeFallback: false, ...defaults };
  if (!settings || String(settings[KEYS.custom]) !== '1') return base;

  const num = (key, fallback) => {
    const raw = settings[key];
    if (!isIntString(raw)) return fallback;
    const [range] = RANGE_OF[key];
    return Math.min(LIMITS[range].max, Math.max(LIMITS[range].min, toInt(raw)));
  };
  let contactMin = num(KEYS.contactMin, SAFE.contact.min);
  let contactMax = num(KEYS.contactMax, SAFE.contact.max);
  let groupMin = num(KEYS.groupMin, SAFE.group.min);
  let groupMax = num(KEYS.groupMax, SAFE.group.max);
  if (contactMax < contactMin) contactMax = contactMin;
  if (groupMax < groupMin) groupMax = groupMin;

  const risky = isRisky({ contactMin, groupMin });
  const acknowledged = !!String(settings[KEYS.ack] || '').trim();
  if (risky && !acknowledged) {
    return { ...base, custom: true, risky: true, acknowledged: false, usingSafeFallback: true };
  }
  return {
    custom: true,
    risky,
    acknowledged,
    usingSafeFallback: false,
    contactMinMs: contactMin * 1000,
    contactMaxMs: contactMax * 1000,
    groupMinMs: groupMin * 60000,
    groupMaxMs: groupMax * 60000,
  };
}

/**
 * Checks a Settings save that touches the timing keys, against what is already stored.
 * Returns the entries to store (the app stamps the risk-confirmation time itself).
 * Throws an Error with a plain-language message when something is not allowed.
 */
function validateTimingEntries(entries, existing = {}, nowIso = new Date().toISOString()) {
  const out = { ...entries };
  const merged = { ...existing, ...entries };

  for (const key of [KEYS.contactMin, KEYS.contactMax, KEYS.groupMin, KEYS.groupMax]) {
    if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
    const [range, unit] = RANGE_OF[key];
    const v = entries[key];
    const { min, max } = LIMITS[range];
    if (!isIntString(v) || toInt(v) < min || toInt(v) > max) {
      throw new Error(`${LABELS[key]} must be a whole number from ${min} to ${max} ${unit === 's' ? 'seconds' : 'minutes'}.`);
    }
    out[key] = String(toInt(v));
  }
  if (Object.prototype.hasOwnProperty.call(entries, KEYS.custom)) {
    out[KEYS.custom] = String(entries[KEYS.custom]) === '1' ? '1' : '0';
  }

  const m = (k) => toInt(out[k] ?? merged[k]);
  const have = (k) => isIntString(out[k] ?? merged[k]);
  const contactMin = have(KEYS.contactMin) ? m(KEYS.contactMin) : SAFE.contact.min;
  const contactMax = have(KEYS.contactMax) ? m(KEYS.contactMax) : SAFE.contact.max;
  const groupMin = have(KEYS.groupMin) ? m(KEYS.groupMin) : SAFE.group.min;
  const groupMax = have(KEYS.groupMax) ? m(KEYS.groupMax) : SAFE.group.max;
  if (contactMax < contactMin) throw new Error('The longest wait between customers cannot be shorter than the shortest wait.');
  if (groupMax < groupMin) throw new Error('The longest wait between groups cannot be shorter than the shortest wait.');

  const customOn = String(out[KEYS.custom] ?? merged[KEYS.custom]) === '1';
  if (customOn && isRisky({ contactMin, groupMin })) {
    // The confirmation must come with THIS save - an old tick never covers a new, faster setting.
    if (String(entries[KEYS.ack] ?? '') !== '1') {
      throw new Error('This speed is faster than the recommended safe limit. Tick the box to confirm you accept the risk of a WhatsApp block, or choose a slower speed.');
    }
    out[KEYS.ack] = nowIso;
  } else if (Object.prototype.hasOwnProperty.call(entries, KEYS.ack)) {
    out[KEYS.ack] = ''; // nothing risky is being saved, so there is nothing to confirm
  }
  return out;
}

module.exports = { PROFILES, DEFAULT_PROFILE_INDEX, SAFE, LIMITS, KEYS, ALL_KEYS, RISK_WARNING, touchesTimingKeys, resolveTiming, validateTimingEntries, isRisky };
