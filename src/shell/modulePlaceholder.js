'use strict';

import { getModule } from './modules.js';
import { iconMarkup } from './icons.js';

export function renderModulePlaceholder(moduleId) {
  const mod = getModule(moduleId);
  const el = document.createElement('div');
  el.className = 'flex h-full w-full flex-col overflow-y-auto bg-surface px-8 py-8 md:px-12';

  if (!mod) {
    el.innerHTML = `<p class="text-ink-secondary">Unknown module: ${moduleId}</p>`;
    return el;
  }

  el.innerHTML = `
    <header class="mb-6 flex items-center gap-3">
      <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <span class="h-6 w-6">${iconMarkup(mod.icon)}</span>
      </span>
      <div>
        <h1 class="font-display text-xl font-bold text-ink">${mod.title}</h1>
        <p class="text-sm text-ink-secondary">${mod.subtitle}</p>
      </div>
      ${
        mod.secured
          ? `<span class="ml-auto inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1 text-xs font-medium text-accent">
               <span class="h-3 w-3">${iconMarkup('lock')}</span> Secured module
             </span>`
          : ''
      }
    </header>
    <div class="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border bg-surface-raised">
      <div class="max-w-sm px-6 text-center">
        <p class="font-display text-base font-bold text-ink">Module UI arrives in a later phase</p>
        <p class="mt-1.5 text-sm text-ink-secondary">
          ${
            mod.secured
              ? 'This screen will sit behind the security gatekeeper (Phase 4).'
              : 'This is a Phase 3 build target.'
          }
          For now, this confirms navigation, the dock, and the workspace-slide
          transition are wired correctly.
        </p>
      </div>
    </div>
  `;

  return el;
}
