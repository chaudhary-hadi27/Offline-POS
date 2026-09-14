'use strict';

import { getModule, DASHBOARD_SHORTCUTS } from './modules.js';
import { iconMarkup } from './icons.js';
import { attachRipple } from './ripple.js';

function shortcutsForRoute(routeId) {
  if (routeId === 'dashboard') return DASHBOARD_SHORTCUTS;
  const mod = getModule(routeId);
  return mod ? [...mod.shortcuts, { keys: 'Ctrl+K', label: 'Command palette' }] : DASHBOARD_SHORTCUTS;
}

export function createShortcutBar({ onRequestOpen }) {
  const bar = document.createElement('button');
  bar.type = 'button';
  bar.title = 'Show all keyboard shortcuts (Ctrl+/)';
  bar.className =
    'ripple-host flex h-8 w-full items-center gap-4 border-t border-border bg-surface-raised px-4 text-[11px] text-ink-muted transition-colors hover:text-ink-secondary';
  attachRipple(bar);
  bar.addEventListener('click', onRequestOpen);

  function render(routeId) {
    const shortcuts = shortcutsForRoute(routeId);
    bar.innerHTML = shortcuts
      .map(
        (s) => `<span class="flex items-center gap-1">
          <kbd class="rounded border border-border-strong px-1 py-0.5 font-medium text-ink-secondary">${s.keys}</kbd>
          ${s.label}
        </span>`
      )
      .join('<span class="text-border-strong">&middot;</span>');
  }

  render('dashboard');

  return { el: bar, render };
}

export function createShortcutSheet() {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-40 hidden';
  overlay.innerHTML = `
    <div class="sheet-scrim absolute inset-0 bg-black/60 backdrop-blur-md"></div>
    <div class="sheet-slide-up absolute bottom-0 left-0 right-0 rounded-t-2xl border-t border-border bg-surface p-6 shadow-modal">
      <div class="mb-4 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="h-5 w-5 text-accent">${iconMarkup('keyboard')}</span>
          <h2 class="font-display text-base font-bold text-ink">Keyboard shortcuts</h2>
        </div>
        <button type="button" class="sheet-close ripple-host flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink">
          <span class="h-4 w-4">${iconMarkup('close')}</span>
        </button>
      </div>
      <div id="sheet-body" class="grid grid-cols-1 gap-2 sm:grid-cols-2"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const panel = overlay.querySelector('.sheet-slide-up');
  const scrim = overlay.querySelector('.sheet-scrim');
  const body = overlay.querySelector('#sheet-body');
  const closeBtn = overlay.querySelector('.sheet-close');
  attachRipple(closeBtn);

  function fillFor(routeId) {
    const shortcuts = shortcutsForRoute(routeId);
    body.innerHTML = shortcuts
      .map(
        (s) => `
        <div class="flex items-center justify-between rounded-xl border border-border px-3.5 py-2.5">
          <span class="text-sm text-ink-secondary">${s.label}</span>
          <kbd class="rounded-md border border-border-strong bg-surface-raised px-2 py-1 text-xs font-medium text-ink">${s.keys}</kbd>
        </div>`
      )
      .join('');
  }

  function isOpen() {
    return !overlay.classList.contains('hidden');
  }

  function open(routeId) {
    fillFor(routeId);
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => panel.classList.add('is-open'));
  }

  function close() {
    panel.classList.remove('is-open');
    setTimeout(() => overlay.classList.add('hidden'), 280);
  }

  scrim.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  return { open, close, isOpen };
}
