'use strict';

/**
 * LICENSE TIERS - the single place that knows which part of the POS needs which licence.
 *
 *   free     no valid licence (not activated / invalid / expired). Only Settings opens.
 *   pro      every page except WhatsApp Deals.
 *   premium  everything, including WhatsApp Deals.
 *
 * "free" is not something you can buy or issue - it is simply the state of a POS without an
 * active licence. A licence key carries "pro" or "premium" inside its signed payload, so the
 * tier cannot be edited without breaking the signature.
 *
 * Enforcement is in the MAIN process (electron/main.js safeHandle -> requiredTierForChannel).
 * The page list below also goes to the screen so it can show lock badges, but hiding a button
 * never protects anything on its own.
 */

const TIERS = ['free', 'pro', 'premium'];
const RANK = { free: 0, pro: 1, premium: 2 };
const TIER_LABELS = { free: 'Free', pro: 'Pro', premium: 'Premium' };

/** The tiers a vendor can put in a key. */
const ISSUABLE_TIERS = ['pro', 'premium'];

/**
 * Keys issued BEFORE tiers existed carry no "tier" field. Those customers paid for the whole
 * POS, so they keep everything. Change this to 'pro' only if you decide old keys should lose WhatsApp.
 */
const LEGACY_TIER = 'premium';

/** Every page of the app (ids match src/shell/modules.js) and the lowest tier that opens it. */
const PAGES = [
  { id: 'settings', title: 'Settings', tier: 'free' },
  { id: 'new-order', title: 'New Order', tier: 'pro' },
  { id: 'menu-setup', title: 'Menu Setup', tier: 'pro' },
  { id: 'order-history', title: 'Order History', tier: 'pro' },
  { id: 'customers', title: 'Customers', tier: 'pro' },
  { id: 'analytics', title: 'Analytics & Reports', tier: 'pro' },
  { id: 'whatsapp-deals', title: 'WhatsApp Deals', tier: 'premium' },
];

/** Features that are not a page of their own. */
const FEATURES = [
  { id: 'whatsapp', title: 'WhatsApp bulk deals (sending, templates, campaigns)', tier: 'premium' },
  { id: 'whatsapp-timing', title: 'Custom WhatsApp sending speed', tier: 'premium' },
];

function normalizeTier(t) {
  const s = String(t || '').toLowerCase();
  return TIERS.includes(s) ? s : null;
}

function tierSatisfies(have, need) {
  const h = RANK[normalizeTier(have) || 'free'];
  const n = RANK[normalizeTier(need) || 'premium']; // an unknown requirement is treated as the strictest
  return h >= n;
}

/**
 * Channels that work with NO licence (the Free tier): everything the Settings page needs
 * (settings, security lock, printers, Danger Zone, Backup) plus the licence screen itself.
 */
function isFreeChannel(channel, CH) {
  const allowed = new Set([
    CH.SETTINGS_GET_ALL,
    CH.SETTINGS_SET,
    CH.PRINTER_LIST_PRINTERS,
    CH.ORDER_DANGER_COUNT,
    CH.ORDER_DANGER_DELETE,
    CH.LICENSE_GET_STATUS,
    CH.LICENSE_ACTIVATE,
    CH.LICENSE_USE,
  ]);
  if (allowed.has(channel)) return true;
  return /^(security|backup):/.test(String(channel));
}

/**
 * The lowest tier that may call an IPC channel.
 * Default is "pro": a channel nobody classified is never silently free, and never
 * silently premium. WhatsApp channels are premium by their prefix.
 */
function requiredTierForChannel(channel, CH) {
  if (isFreeChannel(channel, CH)) return 'free';
  if (/^whatsapp:/.test(String(channel))) return 'premium';
  return 'pro';
}

/** Per-page access for a tier: { 'new-order': { required:'pro', allowed:true }, ... } */
function pageAccess(tier) {
  const out = {};
  for (const p of PAGES) out[p.id] = { title: p.title, required: p.tier, allowed: tierSatisfies(tier, p.tier) };
  return out;
}

function featureAccess(tier) {
  const out = {};
  for (const f of FEATURES) out[f.id] = { title: f.title, required: f.tier, allowed: tierSatisfies(tier, f.tier) };
  return out;
}

/** A human message for a refused call. */
function refusalMessage(have, need) {
  const h = normalizeTier(have) || 'free';
  const n = normalizeTier(need) || 'premium';
  if (h === 'free') return 'The POS is locked. Open Settings > License and enter your license key.';
  return `This feature needs the ${TIER_LABELS[n]} license. Your license is ${TIER_LABELS[h]}. Ask your provider to upgrade it, then enter the new key in Settings > License.`;
}

module.exports = {
  TIERS,
  RANK,
  TIER_LABELS,
  ISSUABLE_TIERS,
  LEGACY_TIER,
  PAGES,
  FEATURES,
  normalizeTier,
  tierSatisfies,
  isFreeChannel,
  requiredTierForChannel,
  pageAccess,
  featureAccess,
  refusalMessage,
};
