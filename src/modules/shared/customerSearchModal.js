'use strict';

import { posApi } from '../../shell/posApi.js';
import { toaster } from '../../shell/toast.js';
import { iconMarkup } from '../../shell/icons.js';
import { attachRipple, attachRippleAll } from '../../shell/ripple.js';

const PAGE_SIZE = 8;
// Below this, every keystroke would either query the whole customer
// table (empty search) or return too many loose matches to be useful -
// waiting for a couple of characters keeps this fast and light even
// once the customer list is in the thousands, since every query still
// goes through the cursor+limit+search backend (never "load everything
// then filter in the browser").
const MIN_QUERY_LENGTH = 2;

/**
 * Opens a lightweight "search all customers" modal - type a name or a
 * phone number (any format - see src/shell/phoneUtils.js), see name +
 * phone for each match, click one to import it. Used by New Order's
 * search icon, next to (not replacing) the existing inline auto-
 * suggest under the name/phone fields, which only ever triggers off a
 * complete phone number.
 *
 * @param {object} opts
 * @param {(customer: object) => void} opts.onSelect
 */
export function openCustomerSearchModal({ onSelect }) {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-start justify-center p-4 pt-24';
  overlay.innerHTML = `
    <div class="customer-search-scrim scrim-enter absolute inset-0 bg-black/60 backdrop-blur-md"></div>
    <div class="modal-pop relative flex max-h-[70vh] w-full max-w-sm flex-col rounded-2xl border border-border bg-surface shadow-modal">
      <div class="flex items-center gap-2 border-b border-border p-3">
        <span class="flex h-9 w-9 flex-shrink-0 items-center justify-center text-ink-muted">
          <span class="h-4.5 w-4.5">${iconMarkup('search')}</span>
        </span>
        <input id="customer-search-input" type="text" autocomplete="off"
          placeholder="Search by name or phone"
          class="flex-1 border-none bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-0" />
        <button type="button" id="customer-search-close" title="Close"
          class="ripple-host flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink">
          <span class="h-4 w-4">${iconMarkup('close')}</span>
        </button>
      </div>
      <div id="customer-search-results" class="flex-1 overflow-y-auto p-2">
        <p class="px-2.5 py-6 text-center text-xs text-ink-muted">Type at least 2 characters to search.</p>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#customer-search-input');
  const resultsEl = overlay.querySelector('#customer-search-results');
  const closeBtn = overlay.querySelector('#customer-search-close');

  let cursor = null;
  let loading = false;
  let currentQuery = '';
  let requestToken = 0;

  function close() {
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
  }
  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      close();
    }
  }
  document.addEventListener('keydown', onKeydown);
  overlay.querySelector('.customer-search-scrim').addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  attachRipple(closeBtn);

  function renderRow(customer) {
    const div = document.createElement('button');
    div.type = 'button';
    div.className =
      'select-row ripple-host flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent/10';
    div.innerHTML = `
      <span class="truncate text-sm font-medium text-ink">${customer.name}</span>
      <span class="truncate text-xs text-ink-muted">${customer.phone}</span>
    `;
    div.addEventListener('click', () => {
      onSelect(customer);
      close();
    });
    return div;
  }

  function renderMessage(text) {
    resultsEl.innerHTML = `<p class="px-2.5 py-6 text-center text-xs text-ink-muted">${text}</p>`;
  }

  async function runSearch(query, { append = false } = {}) {
    const token = ++requestToken;
    loading = true;
    if (!append) {
      resultsEl.innerHTML = '<p class="px-2.5 py-6 text-center text-xs text-ink-muted">Searching...</p>';
      cursor = null;
    }
    try {
      const { rows, nextCursor } = await posApi.customers.list({
        search: query,
        cursor: append ? cursor : null,
        limit: PAGE_SIZE,
      });
      if (token !== requestToken) return; // a newer keystroke already superseded this request

      cursor = nextCursor;
      if (!append) resultsEl.innerHTML = '';
      else resultsEl.querySelector('#customer-search-load-more')?.remove();

      if (rows.length === 0 && !append) {
        renderMessage('No matching customers.');
        return;
      }
      rows.forEach((c) => resultsEl.appendChild(renderRow(c)));
      attachRippleAll(resultsEl, '.select-row');

      if (nextCursor) {
        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.type = 'button';
        loadMoreBtn.id = 'customer-search-load-more';
        loadMoreBtn.className =
          'ripple-host mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-center text-xs text-ink-secondary hover:border-accent/30 hover:text-accent';
        loadMoreBtn.textContent = 'Load more';
        loadMoreBtn.addEventListener('click', () => runSearch(currentQuery, { append: true }));
        resultsEl.appendChild(loadMoreBtn);
        attachRipple(loadMoreBtn);
      }
    } catch (err) {
      if (token !== requestToken) return;
      toaster.error(`Couldn't search customers: ${err.message}`);
      renderMessage('Search failed - try again.');
    } finally {
      if (token === requestToken) loading = false;
    }
  }

  let debounce = null;
  input.addEventListener('input', () => {
    const query = input.value.trim();
    currentQuery = query;
    clearTimeout(debounce);
    if (query.length < MIN_QUERY_LENGTH) {
      requestToken += 1; // invalidate any in-flight request
      renderMessage('Type at least 2 characters to search.');
      return;
    }
    debounce = setTimeout(() => runSearch(query), 250);
  });

  requestAnimationFrame(() => input.focus());
}
