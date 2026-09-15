'use strict';

import { posApi } from './posApi.js';
import { iconMarkup } from './icons.js';
import { attachRipple, attachRippleAll } from './ripple.js';
import { renderOrderHistory } from '../modules/orderHistory.js';
import { renderAnalytics } from '../modules/analytics.js';

/**
 * The popup reached via Ctrl+K -> type "hide" -> Enter -> gatekeeper
 * password.
 *
 * This is NOT a simplified lookalike of Order History and Analytics &
 * Reports - it mounts the SAME two module functions the normal routes
 * use (renderOrderHistory / renderAnalytics), just pointed at
 * `posApi.orders.listDeleted` / `posApi.analytics.getDeletedSummary`
 * instead of the live endpoints. That means every filter, preset,
 * date-range picker, search box, pagination control and the sales
 * chart are the real thing, not a re-implementation that can drift
 * out of sync with the real screens over time. It's read-only in the
 * same sense Order History is read-only - nothing here restores or
 * un-deletes anything.
 *
 * The popup is intentionally full-height/full-width (not a small
 * modal card): both mounted screens are built for a full page, with
 * their own internal scroll areas, filter bars, and (for Analytics) a
 * chart that wants real width - shrinking them into a small dialog
 * would just re-introduce the "not exact" layout problem this was
 * built to avoid.
 *
 * One deliberate difference from the live routes: the History tab is
 * opened with `allowHardDelete: true`, which turns on a "Manage"
 * entry (3-dot menu -> Manage) that lets an admin tick rows and
 * permanently DELETE them - a real SQL delete, not another soft
 * delete. It's scoped to this tab on purpose: everything listed here
 * has already been through Danger Zone once, so there's no path from
 * a live order straight to a hard delete. See allowHardDelete in
 * src/modules/orderHistory.js and permanentlyDeleteOrders() in
 * electron/database/repositories/orders.js.
 */
export function createHiddenRecordsModal() {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 hidden flex-col bg-surface';
  overlay.innerHTML = `
    <header class="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-6 py-3.5">
      <span class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <span class="h-5 w-5">${iconMarkup('lock')}</span>
      </span>
      <h1 class="font-display text-base font-bold text-ink">Hidden Records</h1>
      <div class="flex gap-1.5">
        <button type="button" data-tab="history"
          class="hr-tab-btn ripple-host rounded-lg px-3.5 py-2 text-sm font-medium transition-colors">
          <span class="inline-flex items-center gap-1.5"><span class="h-3.5 w-3.5">${iconMarkup('history')}</span> History</span>
        </button>
        <button type="button" data-tab="reports"
          class="hr-tab-btn ripple-host rounded-lg px-3.5 py-2 text-sm font-medium transition-colors">
          <span class="inline-flex items-center gap-1.5"><span class="h-3.5 w-3.5">${iconMarkup('chart')}</span> Reports</span>
        </button>
      </div>
      <button type="button" class="hr-close ripple-host ml-auto flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink">
        <span class="h-4 w-4">${iconMarkup('close')}</span>
      </button>
    </header>
    <div id="hr-history-mount" class="flex flex-1 flex-col overflow-hidden"></div>
    <div id="hr-reports-mount" class="hidden flex-1 flex-col overflow-hidden"></div>
  `;
  document.body.appendChild(overlay);

  const closeBtn = overlay.querySelector('.hr-close');
  const tabButtons = [...overlay.querySelectorAll('.hr-tab-btn')];
  const historyMount = overlay.querySelector('#hr-history-mount');
  const reportsMount = overlay.querySelector('#hr-reports-mount');
  attachRipple(closeBtn);
  attachRippleAll(overlay, '.hr-tab-btn');

  let activeTab = 'history';
  // Built lazily per open() (not once ever) so re-opening always shows
  // whatever's been soft-deleted since the last time this was open -
  // same freshness guarantee the router gives every normal navigation
  // to Order History / Analytics.
  let historyBuilt = false;
  let reportsBuilt = false;

  function renderTabs() {
    tabButtons.forEach((btn) => {
      const active = btn.dataset.tab === activeTab;
      btn.classList.toggle('bg-accent', active);
      btn.classList.toggle('text-white', active);
      btn.classList.toggle('text-ink-secondary', !active);
      btn.classList.toggle('hover:bg-surface-raised', !active);
    });
    historyMount.classList.toggle('hidden', activeTab !== 'history');
    historyMount.classList.toggle('flex', activeTab === 'history');
    reportsMount.classList.toggle('hidden', activeTab !== 'reports');
    reportsMount.classList.toggle('flex', activeTab === 'reports');

    if (activeTab === 'history' && !historyBuilt) {
      historyBuilt = true;
      historyMount.appendChild(
        renderOrderHistory({
          title: 'Order History',
          emptyMessage: 'Nothing hidden here for this period.',
          fetchList: (opts) => posApi.orders.listDeleted(opts),
          // Only enabled here, never on the live Order History route -
          // everything this list shows has already been through Danger
          // Zone's soft delete once, so "Manage" -> permanent delete is
          // safe to offer.
          allowHardDelete: true,
          // The Reports tab is computed from these same rows, but it's
          // mounted lazily and then cached for the lifetime of this
          // popup (reportsBuilt). Without this invalidation, deleting
          // records in History and switching to Reports would show
          // totals that still counted the orders just destroyed -
          // stale until the whole popup was closed and reopened.
          // Tearing the mount down forces a fresh fetch on next view.
          onRecordsDeleted: () => {
            reportsMount.innerHTML = '';
            reportsBuilt = false;
            if (activeTab === 'reports') renderTabs();
          },
        })
      );
    }
    if (activeTab === 'reports' && !reportsBuilt) {
      reportsBuilt = true;
      reportsMount.appendChild(
        renderAnalytics({
          title: 'Analytics & Reports',
          subtitle: 'Performance of orders removed via Danger Zone',
          fetchSummary: (opts) => posApi.analytics.getDeletedSummary(opts),
        })
      );
    }
  }

  tabButtons.forEach((btn) =>
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      renderTabs();
    })
  );

  function isOpen() {
    return !overlay.classList.contains('hidden');
  }

  function close() {
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
  }

  function open() {
    // Fresh mount every time this popup opens, matching the router's
    // own behaviour of building a brand-new instance on every
    // navigation - reopening Hidden Records always reflects whatever
    // was deleted since it was last opened.
    historyMount.innerHTML = '';
    reportsMount.innerHTML = '';
    historyBuilt = false;
    reportsBuilt = false;
    activeTab = 'history';
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
    renderTabs();
  }

  closeBtn.addEventListener('click', close);

  return { open, close, isOpen };
}
