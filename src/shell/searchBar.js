'use strict';

import { iconMarkup } from './icons.js';

let instanceCounter = 0;

/**
 * Returns the HTML for a consistent search input (search icon + input +
 * clear button), meant to be embedded directly inside a larger template
 * string. Call wireSearchBar() on the same container afterward to attach
 * the actual debounced-search / clear behavior.
 *
 * One shared look-and-feel + one shared interaction model (debounce,
 * Escape-to-clear, a clear button that only appears once there's text)
 * everywhere a page needs to filter a list, instead of every module
 * reinventing its own search input.
 */
export function searchBarHtml({ placeholder = 'Search...', id = null, value = '' } = {}) {
  const inputId = id || `search-bar-${instanceCounter++}`;
  return `
    <div class="search-bar-root relative" data-search-root="${inputId}">
      <span class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted">
        ${iconMarkup('search')}
      </span>
      <input type="text" id="${inputId}" placeholder="${placeholder}" value="${value}" autocomplete="off"
        class="search-bar-input w-full rounded-xl border border-border bg-surface py-2 pl-9 pr-9 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
      <button type="button" class="search-bar-clear absolute right-2 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-ink-muted hover:bg-surface-raised hover:text-ink"
        aria-label="Clear search" tabindex="-1">
        <span class="h-3 w-3">${iconMarkup('close')}</span>
      </button>
    </div>`;
}

/**
 * Wires the debounced-search + clear-button behavior onto a
 * .search-bar-root rendered by searchBarHtml() above.
 *
 * @param {HTMLElement} container - either the .search-bar-root itself, or any ancestor containing it
 * @param {(value:string)=>void} onSearch - called with the trimmed query after the debounce settles, and immediately (with '') when cleared
 * @param {object} [opts]
 * @param {number} [opts.debounceMs=250]
 * @returns {{ getValue():string, setValue(v:string):void, focus():void }}
 */
export function wireSearchBar(container, onSearch, { debounceMs = 250 } = {}) {
  const root = container.classList?.contains('search-bar-root') ? container : container.querySelector('.search-bar-root');
  if (!root) throw new Error('wireSearchBar: no .search-bar-root found in the given container.');

  const input = root.querySelector('.search-bar-input');
  const clearBtn = root.querySelector('.search-bar-clear');
  let debounceTimer = null;

  function updateClearVisibility() {
    const hasText = input.value.length > 0;
    clearBtn.classList.toggle('hidden', !hasText);
    clearBtn.classList.toggle('flex', hasText);
  }

  function clearNow() {
    input.value = '';
    updateClearVisibility();
    clearTimeout(debounceTimer);
    onSearch('');
    input.focus();
  }

  input.addEventListener('input', () => {
    updateClearVisibility();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => onSearch(input.value.trim()), debounceMs);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      clearNow();
    }
  });
  clearBtn.addEventListener('click', clearNow);

  updateClearVisibility();

  return {
    getValue: () => input.value.trim(),
    setValue: (v) => {
      input.value = v;
      updateClearVisibility();
    },
    focus: () => input.focus(),
  };
}
