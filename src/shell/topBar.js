'use strict';

import { posApi } from './posApi.js';
import { onLicenseChange } from './license.js';
import { shellStore } from './state.js';

/**
 * Slim top bar in the style of the Ubuntu panel:
 *
 *     restaurant name         Tue, 27 Oct 2026                 3:54 PM
 *     (left)                  (centre - the date)              (right - the time)
 *
 * It shows the PC's date and time - the same clock the receipts and new orders
 * are stamped with. A small red dot appears next to the date when the POS's own
 * license calendar disagrees with the PC clock (see electron/license/licenseManager.js),
 * so a wrong PC date is noticed before it confuses the reports.
 */
export function createTopBar() {
  const el = document.createElement('header');
  el.className = 'flex h-8 w-full flex-shrink-0 select-none items-center bg-black px-4 text-[13px] font-medium text-white';
  el.innerHTML = `
    <div id="tb-left" class="min-w-0 flex-1 truncate text-white/70"></div>
    <div class="flex flex-shrink-0 items-center justify-center gap-2">
      <span id="tb-warn" class="hidden h-2 w-2 rounded-full bg-[#F87171]" role="img" aria-label="PC date warning"></span>
      <span id="tb-date" class="font-nums"></span>
    </div>
    <div id="tb-time" class="min-w-0 flex-1 text-right font-nums"></div>
  `;

  const left = el.querySelector('#tb-left');
  const dateEl = el.querySelector('#tb-date');
  const timeEl = el.querySelector('#tb-time');
  const warnEl = el.querySelector('#tb-warn');

  function paint() {
    const now = new Date();
    dateEl.textContent = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    timeEl.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // Tick exactly when the minute changes (no seconds are shown, so no need to repaint every second).
  let timer = null;
  function schedule() {
    paint();
    timer = setTimeout(schedule, 60000 - (Date.now() % 60000) + 50);
  }
  schedule();

  async function refreshName() {
    try {
      const s = await posApi.settings.getAll();
      left.textContent = s.restaurant_name || '';
    } catch {
      // the bar is decoration: never let it break the app
    }
  }
  refreshName();
  let lastRoute = shellStore.get().route;
  shellStore.subscribe((state) => {
    if (state.route !== lastRoute) {
      lastRoute = state.route;
      refreshName(); // picks up a changed restaurant name after visiting Settings
    }
  });

  onLicenseChange((s) => {
    const bad = Boolean(s && s.clockWarning);
    warnEl.classList.toggle('hidden', !bad);
    warnEl.title = bad ? s.clockWarning : '';
  });

  return { el, destroy: () => clearTimeout(timer) };
}
