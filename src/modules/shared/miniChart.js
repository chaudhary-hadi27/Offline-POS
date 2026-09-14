'use strict';

/**
 * Small dependency-free chart helpers, generalized from the bar chart
 * already used on the Analytics page (src/modules/analytics.js) so
 * Customer Profiles can reuse the same visual language instead of
 * pulling in a charting library.
 */

/**
 * Renders a simple bar chart from `[{ label, value }]`.
 * @param {Array<{label:string, value:number}>} series
 * @param {object} [opts]
 * @param {(n:number)=>string} [opts.formatValue] - used in bar tooltips
 * @param {string} [opts.emptyMessage]
 */
export function renderBarChart(series, opts = {}) {
  const { formatValue = (n) => String(n), emptyMessage = 'Nothing to show yet.' } = opts;
  if (!series || series.length === 0) {
    return `<div class="flex h-32 items-center justify-center text-sm text-ink-muted">${emptyMessage}</div>`;
  }

  const width = 560;
  const height = 160;
  const padding = 22;
  const max = Math.max(...series.map((d) => d.value), 1);
  const barWidth = (width - padding * 2) / series.length;

  const bars = series
    .map((d, i) => {
      const barHeight = (d.value / max) * (height - padding * 2);
      const x = padding + i * barWidth + barWidth * 0.15;
      const y = height - padding - barHeight;
      const w = barWidth * 0.7;
      return `
        <g class="chart-bar-group">
          <title>${d.label}: ${formatValue(d.value)}</title>
          <rect x="${x}" y="${y}" width="${w}" height="${Math.max(barHeight, 1)}" rx="3"
            fill="#DC2626" class="chart-bar" opacity="0.85" />
          ${series.length <= 12 ? `<text x="${x + w / 2}" y="${height - padding + 14}" text-anchor="middle" font-size="9" fill="#6B7280">${d.label}</text>` : ''}
        </g>`;
    })
    .join('');

  return `
    <svg viewBox="0 0 ${width} ${height + 10}" class="w-full" style="max-height:190px">
      <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#E5E7EB" />
      ${bars}
    </svg>
    <style>.chart-bar-group:hover .chart-bar { opacity: 1; }</style>
  `;
}

/**
 * Renders a ranked horizontal-bar list from `[{ label, value, sublabel }]`
 * (the same visual pattern as Analytics' "Top Selling Items").
 */
export function renderHorizontalBars(items, opts = {}) {
  const { formatSublabel = (item) => String(item.value), emptyMessage = 'Nothing to show yet.' } = opts;
  if (!items || items.length === 0) {
    return `<p class="text-sm text-ink-muted">${emptyMessage}</p>`;
  }
  const maxValue = Math.max(...items.map((i) => i.value), 1);
  return items
    .map(
      (item, i) => `
      <div class="mb-3 last:mb-0">
        <div class="mb-1 flex items-center justify-between text-sm">
          <span class="text-ink"><span class="text-ink-muted">${i + 1}.</span> ${item.label}</span>
          <span class="font-nums text-ink-secondary">${formatSublabel(item)}</span>
        </div>
        <div class="h-1.5 rounded-full bg-surface-raised">
          <div class="h-1.5 rounded-full bg-accent" style="width:${(item.value / maxValue) * 100}%"></div>
        </div>
      </div>`
    )
    .join('');
}
