'use strict';

import { posApi } from '../shell/posApi.js';
import { iconMarkup } from '../shell/icons.js';
import { attachRipple, attachRippleAll } from '../shell/ripple.js';
import { toaster } from '../shell/toast.js';
import { printAndNotify } from './shared/printReceipt.js';
import { getBusinessDayStart, formatLocal } from '../shell/businessDay.js';
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

function orderRow(order) {
  return `
    <tr class="border-t border-border">
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

function tableShell(rowsHtml, emptyMessage) {
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
} = {}) {
  const root = document.createElement('div');
  root.className = 'flex h-full w-full flex-col overflow-hidden bg-surface';

  // day_start_time comes from Settings > Scheduled Business Hours - it's
  // what decides where "Today" actually begins (see src/shell/businessDay.js),
  // so a 3 PM - 3 AM dinner shift doesn't get split across two calendar days.
  let settings = { day_start_time: '00:00' };
  let state = { preset: 'today', page: 1, pageSize: 20, search: '' };

  root.innerHTML = `
    <header class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-8 py-5 md:px-12">
      <div>
        <h1 class="font-display text-xl font-bold text-ink">${title}</h1>
        <p id="history-subtitle" class="text-sm text-ink-secondary">Today</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <div class="w-52">${searchBarHtml({ placeholder: 'Order #, customer, phone', id: 'order-history-search' })}</div>
        <div id="preset-chips" class="flex flex-wrap items-center gap-2"></div>
      </div>
    </header>

    <div id="range-controls" class="hidden flex-wrap items-end gap-3 border-b border-border px-8 py-4 md:px-12">
      <label class="flex flex-col gap-1 text-xs text-ink-secondary">
        From
        <input type="date" id="range-start" class="rounded-lg border border-border px-3 py-2 text-sm" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-ink-secondary">
        To
        <input type="date" id="range-end" class="rounded-lg border border-border px-3 py-2 text-sm" />
      </label>
      <button type="button" id="range-search-btn"
        class="ripple-host rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
        Search
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-8 py-6 md:px-12">
      <div id="orders-table" class="overflow-hidden rounded-2xl border border-border"></div>
      <div id="pagination-controls" class="mt-4 flex justify-center"></div>
    </div>
  `;

  const subtitleEl = root.querySelector('#history-subtitle');
  const chipsEl = root.querySelector('#preset-chips');
  const rangeControls = root.querySelector('#range-controls');
  const rangeStartInput = root.querySelector('#range-start');
  const rangeEndInput = root.querySelector('#range-end');
  const tableEl = root.querySelector('#orders-table');
  const paginationEl = root.querySelector('#pagination-controls');

  const today = new Date();
  const weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
  rangeEndInput.value = today.toISOString().slice(0, 10);
  rangeStartInput.value = weekAgo.toISOString().slice(0, 10);

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
        startDate = `${rangeStartInput.value} 00:00:00`;
        endDate = `${rangeEndInput.value} 23:59:59`;
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
      tableEl.innerHTML = tableShell(result.rows.map(orderRow).join(''), emptyMessage);
      wireReprintButtons();
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
    load();
  });

  (async () => {
    try {
      settings = await posApi.settings.getAll();
    } catch (err) {
      console.error('[order-history] failed to load settings, defaulting day start to midnight', err);
    }
    renderChips();
    load();
  })();

  return root;
}
