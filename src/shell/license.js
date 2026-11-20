'use strict';

import { posApi } from './posApi.js';

/**
 * Renderer-side view of the license. The REAL enforcement is in the main
 * process (every IPC call is refused while locked - see electron/main.js);
 * this just keeps the UI honest: it sends people to Settings > License,
 * shows a banner, and warns before expiry.
 */

let status = null;
const listeners = new Set();

export async function refreshLicense() {
  try {
    status = await posApi.license.getStatus();
  } catch (err) {
    console.error('[license] could not read license status', err);
  }
  listeners.forEach((fn) => fn(status));
  return status;
}

export const getLicenseStatus = () => status;

const TIER_LABEL = { free: 'Free', pro: 'Pro', premium: 'Premium' };
export const tierLabel = (t) => TIER_LABEL[t] || TIER_LABEL.free;

/** The tier in force right now ('free' = no active license). */
export const getTier = () => (status && status.tier) || 'free';

/**
 * Whether a page opens with the current license. The table comes from the main process
 * (electron/license/tiers.js) so the screen never guesses; before the first status arrives
 * nothing is blocked here (the main process enforces regardless).
 */
export function pageAccess(id) {
  const p = status && status.pages && status.pages[id];
  return p || { allowed: true, required: 'free', title: id };
}

/** Same idea for features that are not a page of their own ('whatsapp-timing', ...). */
export function featureAccess(id) {
  const f = status && status.features && status.features[id];
  return f || { allowed: true, required: 'free', title: id };
}

export function accessMessage(id) {
  const a = pageAccess(id);
  if (isLocked()) return 'The POS is locked. Enter your license key in Settings > License.';
  return `${a.title} needs the ${tierLabel(a.required)} license. Your license is ${tierLabel(getTier())}. Ask your provider to upgrade it, then enter the new key in Settings > License.`;
}

/** Small "PRO" / "PREMIUM" tag for things the current license does not include. */
export function tierPillMarkup(required, extraClass = '') {
  if (!required || required === 'free') return '';
  const tone = required === 'premium' ? 'bg-amber-100 text-amber-700' : 'bg-sky-100 text-sky-700';
  return `<span class="tier-pill rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${tone} ${extraClass}">${tierLabel(required)}</span>`;
}
export const isLocked = () => !!status && status.locked === true;

export function onLicenseChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Thin bar above the app: red while locked, amber-red in the last 7 days. */
export function createLicenseBanner({ onOpen }) {
  const el = document.createElement('div');
  el.className = 'hidden flex-shrink-0 items-center justify-center gap-3 px-4 py-2 text-sm font-medium';

  function render(s) {
    if (!s || (!s.locked && !s.expiringSoon)) {
      el.classList.add('hidden');
      el.classList.remove('flex');
      return;
    }
    el.classList.remove('hidden');
    el.classList.add('flex');
    el.className = `flex flex-shrink-0 items-center justify-center gap-3 px-4 py-2 text-sm font-medium ${
      s.locked ? 'bg-[#DC2626] text-white' : 'border-b border-red-200 bg-red-50 text-red-700'
    }`;
    const text = s.locked ? 'POS is locked. Only Settings is available until a license key is entered.' : s.message;
    el.innerHTML = `<span>${text}</span><button type="button" class="rounded-lg border border-current px-2.5 py-1 text-xs font-semibold">Open License</button>`;
    el.querySelector('button').addEventListener('click', onOpen);
  }

  onLicenseChange(render);
  return { el };
}
