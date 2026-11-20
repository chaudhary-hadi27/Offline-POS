import { posApi } from './posApi.js';
import { getTier, onLicenseChange } from './license.js';

/**
 * A bar at the top of the app when a WhatsApp campaign was left unfinished (the app was closed or crashed
 * in the middle of sending). It shows only for a Premium license, once per app start, and goes away when the
 * owner opens the campaign or dismisses it.
 */
export function createCampaignBanner({ onOpen }) {
  const el = document.createElement('div');
  el.className = 'hidden';
  let dismissed = false;

  function hide() {
    el.className = 'hidden';
    el.innerHTML = '';
  }

  async function check() {
    if (dismissed || getTier() !== 'premium') return hide();
    let st = null;
    try {
      st = await posApi.whatsapp.getCampaignState();
    } catch {
      return hide();
    }
    if (!st || st.runState !== 'stopped') return hide();
    const flat = (st.groups || []).flat();
    const sent = flat.filter((c) => c.status === 'sent').length;
    const unsure = flat.filter((c) => c.status === 'uncertain').length;
    const left = flat.filter((c) => c.status === 'pending' || c.status === 'sending').length;
    if (left + unsure === 0) return hide();
    el.className = 'flex flex-shrink-0 items-center justify-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900';
    el.innerHTML = `<span>WhatsApp campaign paused: ${sent} of ${flat.length} sent${unsure ? `, ${unsure} not sure` : ''}.</span>
      <button type="button" data-open class="rounded-lg border border-current px-2.5 py-1 text-xs font-semibold">Continue</button>
      <button type="button" data-dismiss class="px-1 text-xs opacity-70 hover:opacity-100">Not now</button>`;
    el.querySelector('[data-open]').addEventListener('click', () => {
      dismissed = true;
      hide();
      onOpen();
    });
    el.querySelector('[data-dismiss]').addEventListener('click', () => {
      dismissed = true;
      hide();
    });
  }

  onLicenseChange(() => check());
  return { el, check };
}
