'use strict';

import { MODULES } from './modules.js';
import { iconMarkup } from './icons.js';
import { attachRippleAll } from './ripple.js';
import { posApi } from './posApi.js';

function moduleCard(mod) {
  const lockBadge = mod.secured
    ? `<span class="absolute top-3 right-3 flex h-5 w-5 items-center justify-center rounded-full bg-accent/10 text-accent">
         <span class="h-3 w-3">${iconMarkup('lock')}</span>
       </span>`
    : '';

  return `
    <button
      type="button"
      data-module-id="${mod.id}"
      class="module-card ripple-host group relative flex flex-col items-start gap-3 rounded-2xl border border-border
             bg-surface p-5 text-left shadow-card transition-all duration-200 ease-ubuntu
             hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-card-hover
             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
    >
      ${lockBadge}
      <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <span class="h-6 w-6">${iconMarkup(mod.icon)}</span>
      </span>
      <span class="font-display text-[15px] font-bold text-ink">${mod.title}</span>
      <span class="text-sm text-ink-secondary">${mod.subtitle}</span>
    </button>
  `;
}

export function renderDashboard({ onNavigate }) {
  const cashierModules = MODULES.filter((m) => m.block === 'cashier');
  const adminModules = MODULES.filter((m) => m.block === 'admin');

  const el = document.createElement('div');
  el.className = 'h-full w-full overflow-y-auto bg-surface px-8 py-8 md:px-12';
  el.innerHTML = `
    <header class="mb-8 flex flex-wrap items-center justify-between gap-4">
      <div>
        <p class="text-xs font-medium uppercase tracking-wider text-ink-muted">Dashboard</p>
        <h1 id="restaurant-name" class="font-display text-2xl font-bold text-ink">Restaurant POS</h1>
      </div>
      <div class="flex items-center gap-3">
        <button type="button" id="open-palette-btn"
          class="ripple-host flex items-center gap-2 rounded-xl border border-border bg-surface-raised px-3.5 py-2 text-sm text-ink-secondary transition-colors hover:border-accent/30 hover:text-accent">
          <span class="h-4 w-4">${iconMarkup('search')}</span>
          Search modules
          <span class="ml-2 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">Ctrl K</span>
        </button>
      </div>
    </header>

    <section class="mb-10">
      <div class="mb-3 flex items-center gap-2">
        <h2 class="font-display text-sm font-bold uppercase tracking-wide text-ink-secondary">Cashier</h2>
        <span class="h-px flex-1 bg-border"></span>
      </div>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        ${cashierModules.map(moduleCard).join('')}
      </div>
    </section>

    <section class="rounded-2xl border border-border bg-surface-raised p-5">
      <div class="mb-3 flex items-center gap-2">
        <span class="h-4 w-4 text-accent">${iconMarkup('lock')}</span>
        <h2 class="font-display text-sm font-bold uppercase tracking-wide text-ink-secondary">Admin &middot; Secured</h2>
        <span class="h-px flex-1 bg-border"></span>
      </div>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        ${adminModules.map(moduleCard).join('')}
      </div>
    </section>
  `;

  el.querySelectorAll('[data-module-id]').forEach((card) => {
    card.addEventListener('click', () => onNavigate(card.dataset.moduleId));
  });
  el.querySelector('#open-palette-btn').addEventListener('click', () => onNavigate('__open-palette__'));
  attachRippleAll(el, '.ripple-host');

  // Async header data - render skeleton first, fill in once available.
  posApi.settings
    .getAll()
    .then((settings) => {
      const nameEl = el.querySelector('#restaurant-name');
      if (nameEl && settings?.restaurant_name) nameEl.textContent = settings.restaurant_name;
    })
    .catch((err) => console.error('[dashboard] failed to load header data', err));

  return el;
}
