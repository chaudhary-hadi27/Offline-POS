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
