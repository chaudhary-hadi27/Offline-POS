'use strict';

import { posApi } from '../shell/posApi.js';
import { iconMarkup } from '../shell/icons.js';
import { attachRipple, attachRippleAll } from '../shell/ripple.js';
import { toaster } from '../shell/toast.js';
import {
  toMinutes,
  getBusinessDayStart,
  toLocalDateKey,
  businessDateKey,
  businessRangeFromDates,
} from '../shell/businessDay.js';

function money(n) {
  return `Rs. ${Number(n).toFixed(2)}`;
}

/**
 * Date-picker value for a range edge: the BUSINESS day (see
 * src/shell/businessDay.js) the instant belongs to - not the UTC date
 * toISOString() would give, which is off by a day for hours after local
 * midnight in Pakistan.
 */
function toDateInputValue(d, dayStartTime) {
  return businessDateKey(d, dayStartTime);
}

/**
 * Presets are BUSINESS-day based. With a 3 AM day start, "Today" is
 * today's 3:00 AM through tomorrow's 2:59:59 AM, and an order placed at
 * 1 AM still counts toward the previous business day.
 */
function presetRange(preset, dayStartTime) {
  const now = new Date();
  const startMin = toMinutes(dayStartTime || '00:00');
  const dayStart = getBusinessDayStart(now, dayStartTime);
  const at = (y, m, d) => new Date(y, m, d, Math.floor(startMin / 60), startMin % 60, 0, 0);
  const y = dayStart.getFullYear();
  const m = dayStart.getMonth();
  const d = dayStart.getDate();
  const end = new Date(at(y, m, d + 1).getTime() - 1000); // last second of the current business day
  let start;
  if (preset === 'today') {
    start = dayStart;
  } else if (preset === 'week') {
    start = at(y, m, d - dayStart.getDay()); // week starts Sunday
  } else {
    start = at(y, m, 1);
  }
  return { start, end };
}

function metricCard(label, value, icon) {
  return `
    <div class="rounded-2xl border border-border bg-surface p-5">
      <div class="mb-2 flex items-center gap-2 text-ink-muted">
        <span class="h-4 w-4">${iconMarkup(icon)}</span>
        <span class="text-xs font-medium uppercase tracking-wide">${label}</span>
      </div>
      <p class="font-nums font-display text-2xl font-bold text-ink">${value}</p>
    </div>`;
}

function toDayKey(d) {
  return toLocalDateKey(d);
}

/**
 * The backend's dailyBreakdown comes from a SQL GROUP BY day, so it
 * only contains rows for days that actually had orders - correct and
 * efficient for SQL, but a chart built directly from that is
 * misleading: a single sale on the last day of a 31-day "This Month"
 * range would render as ONE bar filling the whole width, with no
 * indication 30 other (quiet) days exist. This fills every day in
 * [start, end] with 0 where the backend didn't return one, so the
 * chart's width always reflects the real time span.
 */
function zeroFillDays(dailyBreakdown, start, end, dayStartTime) {
  const byDay = new Map(dailyBreakdown.map((d) => [d.day, d.total]));
  const days = [];
  // Walk BUSINESS days (the backend groups by the same rule).
  const first = getBusinessDayStart(start, dayStartTime);
  const lastDay = getBusinessDayStart(end, dayStartTime);
  const cursor = new Date(first.getFullYear(), first.getMonth(), first.getDate());
  const last = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate());
  while (cursor <= last) {
    const key = toDayKey(cursor);
    days.push({ day: key, total: byDay.get(key) || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function barChart(dailyBreakdown) {
  if (dailyBreakdown.length === 0) {
    return `<div class="flex h-48 items-center justify-center text-sm text-ink-muted">No sales in this range yet.</div>`;
  }
  const width = 640;
  const height = 200;
  const padding = 24;
  const max = Math.max(...dailyBreakdown.map((d) => d.total), 1);
  const barWidth = (width - padding * 2) / dailyBreakdown.length;

  const bars = dailyBreakdown
    .map((d, i) => {
      const barHeight = (d.total / max) * (height - padding * 2);
      const x = padding + i * barWidth + barWidth * 0.15;
      const y = height - padding - barHeight;
      const w = barWidth * 0.7;
      const label = new Date(d.day + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
      return `
        <g class="chart-bar-group">
          <title>${label}: ${money(d.total)}</title>
          <rect x="${x}" y="${y}" width="${w}" height="${Math.max(barHeight, 1)}" rx="3"
            fill="#DC2626" class="chart-bar" opacity="0.85" />
          ${dailyBreakdown.length <= 14 ? `<text x="${x + w / 2}" y="${height - padding + 14}" text-anchor="middle" font-size="9" fill="#6B7280">${label}</text>` : ''}
        </g>`;
    })
    .join('');

  return `
    <svg viewBox="0 0 ${width} ${height + 10}" class="w-full" style="max-height:220px">
      <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#E5E7EB" />
      ${bars}
    </svg>
    <style>.chart-bar-group:hover .chart-bar { opacity: 1; }</style>
  `;
}

export function renderAnalytics({
  title = 'Analytics & Reports',
  subtitle = 'Sales performance and trends',
  fetchSummary = (opts) => posApi.analytics.getSummary(opts),
} = {}) {
  const root = document.createElement('div');
  root.className = 'flex h-full w-full flex-col overflow-hidden bg-surface';

  let activePreset = 'today';
  let dayStartTime = '00:00'; // replaced by Settings > Business Day once loaded

  root.innerHTML = `
    <header class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-8 py-5 md:px-12">
      <div>
        <h1 class="font-display text-xl font-bold text-ink">${title}</h1>
        <p class="text-sm text-ink-secondary">${subtitle}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <div id="preset-buttons" class="flex gap-1.5"></div>
        <input type="date" id="range-start" class="rounded-lg border border-border px-2.5 py-1.5 text-xs" />
        <span class="text-xs text-ink-muted">to</span>
        <input type="date" id="range-end" class="rounded-lg border border-border px-2.5 py-1.5 text-xs" />
        <button type="button" id="apply-range-btn" class="ripple-host rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover">Apply</button>
      </div>
    </header>

    <div class="flex-1 overflow-y-auto px-8 py-6 md:px-12">
      <div id="metric-cards" class="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4"></div>

      <section class="mb-6 rounded-2xl border border-border bg-surface p-5">
        <h2 class="mb-4 font-display text-sm font-bold text-ink">Sales trend</h2>
        <div id="chart-host"></div>
      </section>

      <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section class="rounded-2xl border border-border bg-surface p-5">
          <h2 class="mb-4 font-display text-sm font-bold text-ink">Top Selling Items</h2>
          <div id="top-items"></div>
        </section>
        <section class="rounded-2xl border border-border bg-surface p-5">
          <h2 class="mb-4 font-display text-sm font-bold text-ink">By Order Type</h2>
          <div id="order-types"></div>
        </section>
      </div>
    </div>
  `;

  const presetButtonsEl = root.querySelector('#preset-buttons');
  const startInput = root.querySelector('#range-start');
  const endInput = root.querySelector('#range-end');

  function renderPresetButtons() {
    presetButtonsEl.innerHTML = [
      ['today', 'Today'],
      ['week', 'This Week'],
      ['month', 'This Month'],
    ]
      .map(
        ([key, label]) => `
        <button type="button" data-preset="${key}"
          class="preset-btn ripple-host rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors
                 ${key === activePreset ? 'border-accent bg-accent/10 text-accent' : 'border-border text-ink-secondary hover:border-accent/30'}">
          ${label}
        </button>`
      )
      .join('');
    presetButtonsEl.querySelectorAll('.preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activePreset = btn.dataset.preset;
        const { start, end } = presetRange(activePreset, dayStartTime);
        startInput.value = toDateInputValue(start, dayStartTime);
        endInput.value = toDateInputValue(end, dayStartTime);
        renderPresetButtons();
        load(start, end);
      });
    });
    attachRippleAll(presetButtonsEl, '.preset-btn');
  }

  root.querySelector('#apply-range-btn').addEventListener('click', () => {
    activePreset = null;
    renderPresetButtons();
    if (!startInput.value || !endInput.value) {
      toaster.error('Pick both a start and end date.');
      return;
    }
    const { start, end } = businessRangeFromDates(startInput.value, endInput.value, dayStartTime);
    load(start, end);
  });
  attachRipple(root.querySelector('#apply-range-btn'));

  function renderMetrics(summary) {
    root.querySelector('#metric-cards').innerHTML = [
      metricCard('Total Sales', money(summary.totalSales), 'chart'),
      metricCard('Tax Collected', money(summary.totalTax), 'receipt'),
      metricCard('Net Sales (excl. tax)', money(summary.netSales), 'history'),
      metricCard('Orders', String(summary.orderCount), 'users'),
    ].join('');
  }

  function renderTopItems(topItems) {
    const el = root.querySelector('#top-items');
    if (topItems.length === 0) {
      el.innerHTML = `<p class="text-sm text-ink-muted">No items sold in this range yet.</p>`;
      return;
    }
    const maxRevenue = Math.max(...topItems.map((i) => i.revenue));
    el.innerHTML = topItems
      .map(
        (item, i) => `
        <div class="mb-3 last:mb-0">
          <div class="mb-1 flex items-center justify-between text-sm">
            <span class="text-ink"><span class="text-ink-muted">${i + 1}.</span> ${item.name}</span>
            <span class="font-nums text-ink-secondary">${item.quantity} sold &middot; ${money(item.revenue)}</span>
          </div>
          <div class="h-1.5 rounded-full bg-surface-raised">
            <div class="h-1.5 rounded-full bg-accent" style="width:${(item.revenue / maxRevenue) * 100}%"></div>
          </div>
        </div>`
      )
      .join('');
  }

  function renderOrderTypes(breakdown) {
    const el = root.querySelector('#order-types');
    if (breakdown.length === 0) {
      el.innerHTML = `<p class="text-sm text-ink-muted">No orders in this range yet.</p>`;
      return;
    }
    el.innerHTML = breakdown
      .map(
        (t) => `
        <div class="mb-3 flex items-center justify-between rounded-xl bg-surface-raised px-4 py-3 last:mb-0">
          <span class="text-sm font-medium text-ink">${t.order_type}</span>
          <span class="font-nums text-sm text-ink-secondary">${t.count} orders &middot; ${money(t.total)}</span>
        </div>`
      )
      .join('');
  }

  async function load(start, end) {
    startInput.value = toDateInputValue(start, dayStartTime);
    endInput.value = toDateInputValue(end, dayStartTime);
    try {
      const summary = await fetchSummary({
        startDate: start.toISOString().slice(0, 19).replace('T', ' '),
        endDate: end.toISOString().slice(0, 19).replace('T', ' '),
        // The backend groups the daily chart into business days using this.
        dayStartMinutes: toMinutes(dayStartTime),
      });
      renderMetrics(summary);
      const filledDays = zeroFillDays(summary.dailyBreakdown, start, end, dayStartTime);
      root.querySelector('#chart-host').innerHTML = barChart(filledDays);
      renderTopItems(summary.topItems);
      renderOrderTypes(summary.orderTypeBreakdown);
    } catch (err) {
      toaster.error('Failed to load analytics: ' + err.message);
    }
  }

  renderPresetButtons();
  (async () => {
    try {
      const settings = await posApi.settings.getAll();
      dayStartTime = settings.day_start_time || '00:00';
    } catch (err) {
      console.error('[analytics] failed to load settings, grouping by midnight', err);
    }
    const { start, end } = presetRange('today', dayStartTime);
    load(start, end);
  })();

  return root;
}
