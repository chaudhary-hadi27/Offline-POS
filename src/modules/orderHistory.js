'use strict';

import { posApi } from '../shell/posApi.js';
import { iconMarkup } from '../shell/icons.js';
import { attachRipple, attachRippleAll } from '../shell/ripple.js';
import { toaster } from '../shell/toast.js';
import { confirmAction } from '../shell/confirmDialog.js';
import { printAndNotify } from './shared/printReceipt.js';
import { getBusinessDayStart, formatLocal, businessRangeFromDates, businessDateKey } from '../shell/businessDay.js';
import { searchBarHtml, wireSearchBar } from '../shell/searchBar.js';

function money(n) {
  return `Rs. ${Number(n).toFixed(2)}`;
}

function formatTime(sqliteUtc) {
  const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z');
  return d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function statusBadge(status) {
  const tones = {
    COMPLETED: 'bg-accent/10 text-accent',
    VOID: 'bg-border-strong/40 text-ink-muted',
    REFUNDED: 'bg-border-strong/40 text-ink-muted',
  };
  return `<span class="rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[status] || tones.COMPLETED}">${status}</span>`;
}

function orderRow(order, { manageMode = false, selected = false } = {}) {
  return `
    <tr class="border-t border-border ${manageMode ? 'cursor-pointer' : ''} ${selected ? 'bg-accent/5' : ''}"
      ${manageMode ? `data-select-row="${order.id}"` : ''}>
      ${
        manageMode
          ? `<td class="w-10 px-4 py-3">
               <input type="checkbox" data-select-id="${order.id}" ${selected ? 'checked' : ''}
                 class="h-4 w-4 rounded border-border-strong text-accent focus:ring-2 focus:ring-accent/30" />
             </td>`
          : ''
      }
      <td class="px-4 py-3">
        <div class="font-medium text-ink">#${order.id}</div>
        <div class="text-xs text-ink-muted">${order.order_type}</div>
      </td>
      <td class="px-4 py-3 text-ink-secondary">${formatTime(order.created_at)}</td>
      <td class="px-4 py-3 text-ink-secondary">${order.customer_name || '—'}</td>
      <td class="px-4 py-3 font-nums font-medium text-ink">${money(order.total)}</td>
      <td class="px-4 py-3">${statusBadge(order.status)}</td>
      <td class="px-4 py-3 text-right">
        <button type="button" data-reprint="${order.id}"
          class="ripple-host inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover">
          <span class="h-3.5 w-3.5">${iconMarkup('print')}</span> Reprint
        </button>
      </td>
    </tr>`;
}

function tableShell(rowsHtml, emptyMessage, { manageMode = false, allSelectedOnPage = false } = {}) {
  if (!rowsHtml) {
    return `
      <div class="flex flex-col items-center justify-center gap-2 bg-surface-raised px-6 py-16 text-center">
        <span class="h-8 w-8 text-ink-muted">${iconMarkup('history')}</span>
        <p class="text-sm text-ink-secondary">${emptyMessage}</p>
      </div>`;
  }
  return `
    <table class="w-full text-left text-sm">
      <thead class="bg-surface-raised text-xs uppercase tracking-wide text-ink-muted">
        <tr>
          ${
            manageMode
              ? `<th class="w-10 px-4 py-3">
                   <input type="checkbox" id="select-all-checkbox" ${allSelectedOnPage ? 'checked' : ''}
                     class="h-4 w-4 rounded border-border-strong text-accent focus:ring-2 focus:ring-accent/30" />
                 </th>`
              : ''
          }
          <th class="px-4 py-3 font-medium">Order</th>
          <th class="px-4 py-3 font-medium">Time</th>
          <th class="px-4 py-3 font-medium">Customer</th>
          <th class="px-4 py-3 font-medium">Total</th>
          <th class="px-4 py-3 font-medium">Status</th>
          <th class="px-4 py-3 font-medium text-right">Action</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'custom', label: 'Custom' },
];

export function renderOrderHistory({
  title = 'Order History',
  fetchList = (opts) => posApi.orders.listByRange(opts),
  emptyMessage = 'No orders found for this period.',
  // Only Hidden Records' History tab passes this - it's the one place
  // "permanent" makes sense, because everything listed there has
  // already been through Danger Zone's soft delete once. The live
  // Order History route never sets this, so it keeps its current,
  // reprint-only behaviour untouched.
  allowHardDelete = false,
  // Called after a successful permanent delete. Hidden Records uses
  // this to invalidate its Reports tab, which is computed from these
  // same rows and would otherwise keep showing figures for orders
  // that no longer exist.
  onRecordsDeleted = null,
} = {}) {
  const root = document.createElement('div');
  root.className = 'flex h-full w-full flex-col overflow-hidden bg-surface';

  // day_start_time comes from Settings > Scheduled Business Hours - it's
  // what decides where "Today" actually begins (see src/shell/businessDay.js),
  // so a 3 PM - 3 AM dinner shift doesn't get split across two calendar days.
  let settings = { day_start_time: '00:00' };
  let state = { preset: 'today', page: 1, pageSize: 20, search: '' };
  // Manage mode (permanent delete): selectedIds persists across page
  // changes within a manage session, so someone can tick a few rows
  // on page 1, page over, tick a few more, then delete all at once.
  // It's cleared on preset/search change (the result set underneath
  // it just changed) and whenever manage mode is exited.
  let manageMode = false;
  let selectedIds = new Set();
  let lastRowIds = [];
  // id -> true when that order is still live (not soft-deleted); used by the
  // permanent-delete confirmation to say how many live orders are included.
  const liveById = new Map();

  root.innerHTML = `
    <header class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-8 sm:py-5 md:px-12">
      <div>
        <h1 class="font-display text-lg font-bold text-ink sm:text-xl">${title}</h1>
        <p id="history-subtitle" class="text-sm text-ink-secondary">Today</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <div class="w-full max-w-[13rem] sm:w-52">${searchBarHtml({ placeholder: 'Order #, customer, phone', id: 'order-history-search' })}</div>
        <div id="preset-chips" class="flex flex-wrap items-center gap-2"></div>
        ${
          allowHardDelete
            ? `<div class="relative">
                 <button type="button" id="history-menu-btn" title="More options"
                   class="ripple-host flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-border text-ink-secondary hover:border-accent/30 hover:text-accent">
                   <span class="h-4 w-4">${iconMarkup('moreVertical')}</span>
                 </button>
                 <div id="history-menu"
                   class="hidden absolute right-0 top-full z-20 mt-1.5 w-44 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-modal">
                   <button type="button" id="manage-mode-btn"
                     class="ripple-host flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm font-medium text-ink hover:bg-surface-raised">
                     <span class="h-3.5 w-3.5">${iconMarkup('trash')}</span> Manage
                   </button>
                 </div>
               </div>`
            : ''
        }
      </div>
    </header>

    ${
      allowHardDelete
        ? `<div id="manage-toolbar" class="hidden flex-wrap items-center justify-between gap-3 border-b border-border bg-accent/5 px-4 py-3 sm:px-8 md:px-12">
             <div class="flex items-center gap-2.5">
               <button type="button" id="manage-exit-btn" title="Cancel"
                 class="ripple-host flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-surface-raised hover:text-ink">
                 <span class="h-4 w-4">${iconMarkup('close')}</span>
               </button>
               <span id="manage-count" class="text-sm font-medium text-ink">0 selected</span>
               <button type="button" id="manage-select-all-btn"
                 class="ripple-host rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">
                 Select all on page
               </button>
             </div>
             <button type="button" id="manage-delete-btn" disabled
               class="ripple-host flex items-center gap-1.5 rounded-xl bg-red-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40">
               <span class="h-3.5 w-3.5">${iconMarkup('trash')}</span> Delete permanently
             </button>
           </div>`
        : ''
    }

    <div id="range-controls" class="hidden flex-wrap items-end gap-3 border-b border-border px-4 py-4 sm:px-8 md:px-12">
      <label class="flex flex-col gap-1 text-xs text-ink-secondary">
        From
        <input type="date" id="range-start" class="w-full rounded-lg border border-border px-3 py-2 text-sm sm:w-auto" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-ink-secondary">
        To
        <input type="date" id="range-end" class="w-full rounded-lg border border-border px-3 py-2 text-sm sm:w-auto" />
      </label>
      <button type="button" id="range-search-btn"
        class="ripple-host rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
        Search
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-4 py-6 sm:px-8 md:px-12">
      <div id="orders-table" class="overflow-x-auto rounded-2xl border border-border"></div>
      <div id="pagination-controls" class="mt-4 flex justify-center"></div>
    </div>
  `;

  const subtitleEl = root.querySelector('#history-subtitle');
  const chipsEl = root.querySelector('#preset-chips');
  const rangeControls = root.querySelector('#range-controls');
  const rangeStartInput = root.querySelector('#range-start');
  const rangeEndInput = root.querySelector('#range-end');
  const historyMenuBtn = root.querySelector('#history-menu-btn');
  const historyMenu = root.querySelector('#history-menu');
  const manageModeBtn = root.querySelector('#manage-mode-btn');
  const manageToolbar = root.querySelector('#manage-toolbar');
  const manageExitBtn = root.querySelector('#manage-exit-btn');
  const manageCountEl = root.querySelector('#manage-count');
  const manageSelectAllBtn = root.querySelector('#manage-select-all-btn');
  const manageDeleteBtn = root.querySelector('#manage-delete-btn');
  const tableEl = root.querySelector('#orders-table');
  const paginationEl = root.querySelector('#pagination-controls');

  const today = new Date();
  const weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
  // Local calendar dates - toISOString() would give the UTC date, which is
  // yesterday's date for the first hours after midnight in Pakistan.
  const localDate = (d) => formatLocal(d).slice(0, 10);
  rangeEndInput.value = localDate(today);
  rangeStartInput.value = localDate(weekAgo);
  // Once settings load (below), re-point the pickers at today's BUSINESS date.
  function syncRangeInputsToBusinessDay() {
    const biz = new Date(`${businessDateKey(new Date(), settings.day_start_time)}T00:00:00`);
    rangeEndInput.value = localDate(biz);
    rangeStartInput.value = localDate(new Date(biz.getTime() - 6 * 24 * 60 * 60 * 1000));
  }

  function renderChips() {
    chipsEl.innerHTML = PRESETS.map(
      (p) => `
      <button type="button" data-preset="${p.key}"
        class="preset-chip ripple-host rounded-xl border px-3.5 py-2 text-sm font-medium transition-colors
               ${state.preset === p.key ? 'border-accent bg-accent text-white' : 'border-border text-ink-secondary hover:border-accent/30 hover:text-accent'}">
        ${p.label}
      </button>`
    ).join('');
    chipsEl.querySelectorAll('.preset-chip').forEach((btn) => {
      btn.addEventListener('click', () => selectPreset(btn.dataset.preset));
    });
    attachRippleAll(chipsEl, '.preset-chip');
  }

  function wireReprintButtons() {
    tableEl.querySelectorAll('[data-reprint]').forEach((btn) => {
      btn.addEventListener('click', () => printAndNotify(Number(btn.dataset.reprint)));
    });
    attachRippleAll(tableEl, '[data-reprint]');
  }

  // ---- Manage mode (Hidden Records only): tick rows, hard-delete ----

  function updateManageToolbar() {
    if (!manageToolbar) return;
    manageCountEl.textContent = `${selectedIds.size} selected`;
    manageDeleteBtn.disabled = selectedIds.size === 0;
  }

  function clearSelection() {
    selectedIds = new Set();
    updateManageToolbar();
  }

  function enterManageMode() {
    manageMode = true;
    selectedIds = new Set();
    manageToolbar.classList.remove('hidden');
    manageToolbar.classList.add('flex');
    updateManageToolbar();
    load();
  }

  function exitManageMode() {
    manageMode = false;
    selectedIds = new Set();
    manageToolbar.classList.add('hidden');
    manageToolbar.classList.remove('flex');
    load();
  }

  function closeHistoryMenu() {
    if (historyMenu) historyMenu.classList.add('hidden');
  }

  function updateSelectAllCheckboxUI() {
    const selectAllCheckbox = tableEl.querySelector('#select-all-checkbox');
    if (!selectAllCheckbox) return;
    selectAllCheckbox.checked = lastRowIds.length > 0 && lastRowIds.every((id) => selectedIds.has(id));
  }

  function wireManageCheckboxes() {
    if (!manageMode) return;
    const selectAllCheckbox = tableEl.querySelector('#select-all-checkbox');
    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener('change', () => {
        if (selectAllCheckbox.checked) lastRowIds.forEach((id) => selectedIds.add(id));
        else lastRowIds.forEach((id) => selectedIds.delete(id));
        updateManageToolbar();
        tableEl.querySelectorAll('[data-select-id]').forEach((cb) => {
          cb.checked = selectedIds.has(Number(cb.dataset.selectId));
          cb.closest('tr')?.classList.toggle('bg-accent/5', cb.checked);
        });
      });
    }
    tableEl.querySelectorAll('[data-select-id]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = Number(cb.dataset.selectId);
        if (cb.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        cb.closest('tr')?.classList.toggle('bg-accent/5', cb.checked);
        updateManageToolbar();
        updateSelectAllCheckboxUI();
      });
    });
    // Tapping anywhere on the row toggles its checkbox too - a small
    // touch target is a mis-tap magnet on a phone-sized screen.
    tableEl.querySelectorAll('[data-select-row]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-reprint]')) return;
        const cb = row.querySelector('[data-select-id]');
        if (!cb || e.target === cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
    });
  }

  function computeBounds(preset) {
    const now = new Date();
    const dayStart = getBusinessDayStart(now, settings.day_start_time);
    if (preset === 'today') return { start: dayStart, end: now };
    if (preset === 'yesterday') {
      const start = new Date(dayStart);
      start.setDate(start.getDate() - 1);
      return { start, end: dayStart };
    }
    if (preset === 'week') {
      const start = new Date(dayStart);
      start.setDate(start.getDate() - 6);
      return { start, end: now };
    }
    if (preset === 'month') {
      const start = new Date(dayStart);
      start.setDate(start.getDate() - 29);
      return { start, end: now };
    }
    return null;
  }

  function subtitleFor(preset) {
    if (preset === 'today') return 'Today';
    if (preset === 'yesterday') return 'Yesterday';
    if (preset === 'week') return 'Last 7 days';
    if (preset === 'month') return 'Last 30 days';
    const fmt = (v) => new Date(`${v}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${fmt(rangeStartInput.value)} – ${fmt(rangeEndInput.value)}`;
  }

  async function load() {
    try {
      let startDate;
      let endDate;
      if (state.preset === 'custom') {
        if (!rangeStartInput.value || !rangeEndInput.value) {
          toaster.error('Pick both a start and end date.');
          return;
        }
        // Picked dates are BUSINESS days, not calendar days - e.g. with a
        // 3 AM day start, "12 Oct" runs 12 Oct 3:00 AM -> 13 Oct 2:59 AM.
        const range = businessRangeFromDates(rangeStartInput.value, rangeEndInput.value, settings.day_start_time);
        startDate = formatLocal(range.start);
        endDate = formatLocal(range.end);
      } else {
        const bounds = computeBounds(state.preset);
        startDate = formatLocal(bounds.start);
        endDate = formatLocal(bounds.end);
      }

      const result = await fetchList({
        startDate,
        endDate,
        page: state.page,
        pageSize: state.pageSize,
        search: state.search || null,
      });

      subtitleEl.textContent = subtitleFor(state.preset);
      lastRowIds = result.rows.map((o) => o.id);
      result.rows.forEach((o) => liveById.set(o.id, !o.deleted_at));
      const allSelectedOnPage = manageMode && lastRowIds.length > 0 && lastRowIds.every((id) => selectedIds.has(id));
      const rowsHtml = result.rows
        .map((order) => orderRow(order, { manageMode, selected: selectedIds.has(order.id) }))
        .join('');
      tableEl.innerHTML = tableShell(rowsHtml, emptyMessage, { manageMode, allSelectedOnPage });
      wireReprintButtons();
      wireManageCheckboxes();
      if (manageMode) updateManageToolbar();
      renderPagination(result);
    } catch (err) {
      toaster.error('Failed to load order history: ' + err.message);
    }
  }

  function renderPagination(result) {
    if (result.totalPages <= 1) {
      paginationEl.innerHTML = '';
      return;
    }
    const buttons = [];
    for (let p = 1; p <= result.totalPages; p++) {
      buttons.push(`
        <button type="button" data-page="${p}"
          class="page-btn ripple-host h-8 w-8 rounded-lg text-sm transition-colors
                 ${p === result.page ? 'bg-accent text-white' : 'text-ink-secondary hover:bg-surface-raised'}">
          ${p}
        </button>`);
    }
    const nextPage = result.page < result.totalPages ? result.page + 1 : null;
    paginationEl.innerHTML = `
      <div class="flex items-center gap-1.5">
        ${buttons.join('')}
        ${
          nextPage
            ? `<button type="button" id="next-page-btn"
                 class="ripple-host ml-1 flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm text-ink-secondary hover:border-accent/30 hover:text-accent">
                 View next page
               </button>`
            : ''
        }
      </div>`;
    paginationEl.querySelectorAll('.page-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.page = Number(btn.dataset.page);
        load();
      });
    });
    const nextBtn = paginationEl.querySelector('#next-page-btn');
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        state.page = nextPage;
        load();
      });
      attachRipple(nextBtn);
    }
    attachRippleAll(paginationEl, '.page-btn');
  }

  function selectPreset(preset) {
    state.preset = preset;
    state.page = 1;
    if (manageMode) clearSelection();
    renderChips();
    if (preset === 'custom') {
      rangeControls.classList.remove('hidden');
      rangeControls.classList.add('flex');
    } else {
      rangeControls.classList.add('hidden');
      rangeControls.classList.remove('flex');
    }
    load();
  }

  root.querySelector('#range-search-btn').addEventListener('click', () => {
    state.page = 1;
    load();
  });
  attachRipple(root.querySelector('#range-search-btn'));

  wireSearchBar(root, (value) => {
    state.search = value;
    state.page = 1;
    if (manageMode) clearSelection();
    load();
  });

  if (allowHardDelete) {
    attachRipple(historyMenuBtn);
    attachRipple(manageModeBtn);
    attachRipple(manageExitBtn);
    attachRipple(manageSelectAllBtn);
    attachRipple(manageDeleteBtn);

    historyMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !historyMenu.classList.contains('hidden');
      closeHistoryMenu();
      if (!isOpen) historyMenu.classList.remove('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#history-menu-btn') && !e.target.closest('#history-menu')) {
        closeHistoryMenu();
      }
    });

    manageModeBtn.addEventListener('click', () => {
      closeHistoryMenu();
      enterManageMode();
    });

    manageExitBtn.addEventListener('click', exitManageMode);

    manageSelectAllBtn.addEventListener('click', () => {
      const allSelected = lastRowIds.length > 0 && lastRowIds.every((id) => selectedIds.has(id));
      if (allSelected) lastRowIds.forEach((id) => selectedIds.delete(id));
      else lastRowIds.forEach((id) => selectedIds.add(id));
      updateManageToolbar();
      tableEl.querySelectorAll('[data-select-id]').forEach((cb) => {
        cb.checked = selectedIds.has(Number(cb.dataset.selectId));
        cb.closest('tr')?.classList.toggle('bg-accent/5', cb.checked);
      });
      updateSelectAllCheckboxUI();
    });

    manageDeleteBtn.addEventListener('click', async () => {
      const ids = [...selectedIds];
      if (ids.length === 0) return;
      const liveCount = ids.filter((id) => liveById.get(id)).length;
      const liveNote =
        liveCount > 0
          ? ` ${liveCount} of them ${liveCount === 1 ? 'is a' : 'are'} LIVE order${liveCount === 1 ? '' : 's'} (still in Order History and Reports), so ${liveCount === 1 ? 'it' : 'they'} will disappear from there too.`
          : '';
      const confirmed = await confirmAction({
        title: `Permanently delete ${ids.length} order${ids.length === 1 ? '' : 's'}?`,
        message: `This removes ${ids.length === 1 ? 'it' : 'them'} and their line items from the database for good - it cannot be undone.${liveNote} Customer profiles are never affected.`,
        confirmLabel: 'Delete permanently',
        tone: 'danger',
        requireTypedConfirmation: 'DELETE',
      });
      if (!confirmed) return;
      manageDeleteBtn.disabled = true;
      try {
        const { deleted } = await posApi.orders.hardDelete(ids);
        toaster.success(`Permanently deleted ${deleted} order${deleted === 1 ? '' : 's'}.`);
        exitManageMode();
        onRecordsDeleted?.(deleted);
      } catch (err) {
        toaster.error('Failed to delete: ' + err.message);
        manageDeleteBtn.disabled = selectedIds.size === 0;
      }
    });
  }

  (async () => {
    try {
      settings = await posApi.settings.getAll();
      syncRangeInputsToBusinessDay();
    } catch (err) {
      console.error('[order-history] failed to load settings, defaulting day start to midnight', err);
    }
    renderChips();
    load();
  })();

  return root;
}
