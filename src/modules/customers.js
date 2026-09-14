'use strict';

import { posApi } from '../shell/posApi.js';
import { iconMarkup } from '../shell/icons.js';
import { attachRipple, attachRippleAll } from '../shell/ripple.js';
import { toaster } from '../shell/toast.js';
import { confirmAction } from '../shell/confirmDialog.js';
import { renderBarChart, renderHorizontalBars } from './shared/miniChart.js';
import { searchBarHtml, wireSearchBar } from '../shell/searchBar.js';

// Mirrors the thresholds in electron/database/repositories/customers.js -
// used here only to badge rows in the list, the actual filtering happens
// server-side (real DB) / in the mock, both driven by the same numbers.
const REGULAR_MIN_ORDERS = 3;
const HIGH_SPENDER_MIN_TOTAL = 5000;

/** Mirrors electron/utils/phone.js - same normalization, used here only
 *  for the "already exists" duplicate check on Add Customer so it
 *  catches "0300 1234567" vs "+92 300 1234567" etc, not just an exact
 *  string match. The DB is still the source of truth for phone_normalized. */
function normalizePhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D+/g, '');
  if (!digits) return '';
  digits = digits.replace(/^0092/, '').replace(/^92/, '').replace(/^0/, '');
  return digits ? `92${digits}` : '';
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'regular', label: 'Regular' },
  { key: 'high_spender', label: 'High Spender' },
];

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

function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return `${d.toLocaleDateString([], { month: 'short' })} '${String(y).slice(-2)}`;
}

/** "Customer for 8 months · since Jan 2025" style tenure line. */
function tenureLabel(createdAt) {
  if (!createdAt) return 'Customer since —';
  const created = new Date(createdAt.replace(' ', 'T') + 'Z');
  const now = new Date();
  const months = (now.getFullYear() - created.getFullYear()) * 12 + (now.getMonth() - created.getMonth());
  const dateLabel = created.toLocaleDateString([], { month: 'short', year: 'numeric' });
  if (months < 1) return `New customer, joined ${dateLabel}`;
  if (months < 12) return `Customer for ${months} month${months === 1 ? '' : 's'} (since ${dateLabel})`;
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  const yearsLabel = `${years} year${years === 1 ? '' : 's'}${remMonths ? ` ${remMonths} mo` : ''}`;
  return `Customer for ${yearsLabel} (since ${dateLabel})`;
}

function statCard(label, value, icon) {
  return `
    <div class="rounded-2xl border border-border bg-surface p-5">
      <div class="mb-2 flex items-center gap-2 text-ink-muted">
        <span class="h-4 w-4">${iconMarkup(icon)}</span>
        <span class="text-xs font-medium uppercase tracking-wide">${label}</span>
      </div>
      <p class="font-nums font-display text-xl font-bold text-ink">${value}</p>
    </div>`;
}

export function renderCustomers() {
  const root = document.createElement('div');
  root.className = 'flex h-full w-full flex-col overflow-hidden bg-surface';
  root.innerHTML = `<div id="view-host" class="flex h-full w-full flex-col overflow-hidden"></div>`;
  const viewHost = root.querySelector('#view-host');

  // The Add Customer modal is built once here and appended straight to
  // document.body - NOT left nested inside viewHost. viewHost lives
  // inside a route-layer that gets a CSS `transform` applied for the
  // page-switch slide animation, and a `transform` on any ancestor
  // makes `position: fixed` descendants center/size themselves against
  // that ancestor's box instead of the real viewport - so a modal left
  // nested in there winds up looking centered in the content pane
  // (offset by the sidebar's width) rather than the whole app window.
  // Building it once at the top level (instead of inside showList(),
  // which reruns on every "back to list" navigation) also means it
  // isn't rebuilt/re-appended - and duplicated - on every rerender.
  const overlay = document.createElement('div');
  overlay.id = 'add-customer-overlay';
  overlay.className = 'fixed inset-0 z-40 hidden flex items-center justify-center p-4';
  overlay.innerHTML = `
    <div class="ac-scrim absolute inset-0 bg-black/60 backdrop-blur-md"></div>
    <div class="modal-pop relative w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-modal">
      <h2 class="mb-4 font-display text-lg font-bold text-ink">Add Customer</h2>
      <form id="add-customer-form" class="flex flex-col gap-3">
        <input name="name" required placeholder="Customer name"
          class="rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
        <input name="phone" required placeholder="Phone number"
          class="rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
        <textarea name="address" rows="2" placeholder="Address (optional)"
          class="rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"></textarea>
        <div class="mt-2 flex gap-3">
          <button type="submit" class="ripple-host flex-1 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover">Save</button>
          <button type="button" id="ac-cancel" class="ripple-host rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-ink-secondary hover:bg-surface-raised">Cancel</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  const form = overlay.querySelector('#add-customer-form');

  function openAddPanel() {
    form.reset();
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.querySelector('.ac-scrim').classList.add('scrim-enter')));
  }
  function closeAddPanel() {
    overlay.classList.add('hidden');
    overlay.querySelector('.ac-scrim').classList.remove('scrim-enter');
  }
  overlay.querySelector('#ac-cancel').addEventListener('click', closeAddPanel);
  overlay.querySelector('.ac-scrim').addEventListener('click', closeAddPanel);
  attachRipple(overlay.querySelector('#ac-cancel'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const name = data.name.trim();
    const phone = data.phone.trim();
    try {
      // Duplicate handling: a customer already on file with this
      // number (in ANY format - spaces, dashes, +92 vs 0, etc.) is
      // never silently overwritten by "+ Add Customer" - we open
      // their existing profile instead.
      const normalized = normalizePhone(phone);
      const { rows: possibleMatches } = await posApi.customers.list({ search: phone, limit: 5 });
      const exactMatch = possibleMatches.find((c) => normalizePhone(c.phone) === normalized);
      if (exactMatch) {
        toaster.show(`"${exactMatch.name}" already exists with that number - opening their profile.`, { duration: 2600 });
        closeAddPanel();
        showDetail(exactMatch.id);
        return;
      }
      const customer = await posApi.customers.upsert({ name, phone });
      if (data.address?.trim()) {
        await posApi.customers.addAddress(customer.id, { address: data.address.trim(), isDefault: true });
      }
      toaster.success(`"${name}" added.`);
      closeAddPanel();
      await refreshList();
    } catch (err) {
      toaster.error(err.message);
    }
  });

  let refreshList = async () => {}; // reassigned to the real loadList() once showList() runs (below)
  let listRows = [];
  let listCursor = null;
  let searchTerm = '';
  let activeFilter = 'all';
  let duplicatePhoneSet = new Set();

  // ---------------------------------------------------------------
  // LIST VIEW - the customer database, with search + loyalty filters
  // ---------------------------------------------------------------
  function showList() {
    viewHost.innerHTML = `
      <header class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-8 py-5 md:px-12">
        <div>
          <h1 class="font-display text-xl font-bold text-ink">Customers</h1>
          <p class="text-sm text-ink-secondary">Customer directory &amp; delivery addresses</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="w-56">${searchBarHtml({ placeholder: 'Search by name or phone', id: 'customer-search', value: searchTerm })}</div>
          <button type="button" id="add-customer-btn"
            class="ripple-host flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-card transition-colors hover:bg-accent-hover">
            + Add Customer
          </button>
        </div>
      </header>

      <div class="flex flex-wrap items-center gap-2 border-b border-border px-8 py-3 md:px-12">
        <span class="flex h-4 w-4 flex-shrink-0 text-ink-muted">${iconMarkup('filter')}</span>
        <div id="filter-chips" class="flex flex-wrap items-center gap-2"></div>
      </div>

      <div class="flex-1 overflow-y-auto px-8 py-6 md:px-12">
        <div id="customer-list" class="flex flex-col gap-2.5"></div>
        <div id="pagination-controls" class="mt-4 flex justify-center"></div>
      </div>
    `;

    const listEl = viewHost.querySelector('#customer-list');
    const paginationEl = viewHost.querySelector('#pagination-controls');
    const chipsEl = viewHost.querySelector('#filter-chips');
    const addBtn = viewHost.querySelector('#add-customer-btn');

    attachRipple(addBtn);

    function renderChips() {
      chipsEl.innerHTML = FILTERS.map(
        (f) => `
        <button type="button" data-filter="${f.key}"
          class="filter-chip ripple-host rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors
                 ${activeFilter === f.key ? 'border-accent bg-accent text-white' : 'border-border text-ink-secondary hover:border-accent/30 hover:text-accent'}">
          ${f.label}
        </button>`
      ).join('');
      chipsEl.querySelectorAll('.filter-chip').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeFilter = btn.dataset.filter;
          renderChips();
          loadList();
        });
      });
      attachRippleAll(chipsEl, '.filter-chip');
    }
    renderChips();

    addBtn.addEventListener('click', openAddPanel);

    function customerRow(customer) {
      const tags = [];
      if ((customer.order_count || 0) >= REGULAR_MIN_ORDERS) {
        tags.push(`<span class="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">Regular</span>`);
      }
      if ((customer.total_spent || 0) >= HIGH_SPENDER_MIN_TOTAL) {
        tags.push(`<span class="rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">High Spender</span>`);
      }
      if (customer.phone_normalized && duplicatePhoneSet.has(customer.phone_normalized)) {
        tags.push(
          `<span title="Another profile on file shares this phone number - probably the same person entered under a different number format." class="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">Possible Duplicate</span>`
        );
      }
      return `
        <button type="button" data-customer-row="${customer.id}"
          class="customer-row ripple-host flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4 text-left transition-colors hover:border-accent/30 hover:bg-surface-raised">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <p class="font-medium text-ink">${customer.name}</p>
              ${tags.join('')}
            </div>
            <p class="text-sm text-ink-secondary">${customer.phone}</p>
          </div>
          <div class="flex flex-shrink-0 items-center gap-4">
            <div class="text-right">
              <p class="font-nums text-sm font-medium text-ink">${money(customer.total_spent || 0)}</p>
              <p class="text-xs text-ink-muted">${customer.order_count || 0} orders</p>
            </div>
            <span class="h-4 w-4 text-ink-muted">${iconMarkup('chevronRight')}</span>
          </div>
        </button>`;
    }

    function renderList(append = false) {
      if (listRows.length === 0) {
        listEl.innerHTML = `
          <div class="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-surface-raised px-6 py-16 text-center">
            <span class="h-8 w-8 text-ink-muted">${iconMarkup('users')}</span>
            <p class="text-sm text-ink-secondary">${searchTerm || activeFilter !== 'all' ? 'No customers match this view.' : 'No customers yet.'}</p>
          </div>`;
        paginationEl.innerHTML = '';
        return;
      }

      const html = listRows.map(customerRow).join('');
      if (append) listEl.insertAdjacentHTML('beforeend', html);
      else listEl.innerHTML = html;

      listEl.querySelectorAll('[data-customer-row]').forEach((btn) => {
        btn.addEventListener('click', () => showDetail(Number(btn.dataset.customerRow)));
      });
      attachRippleAll(listEl, '[data-customer-row]');

      paginationEl.innerHTML = listCursor
        ? `<button type="button" id="load-more-btn" class="ripple-host rounded-xl border border-border px-4 py-2 text-sm text-ink-secondary hover:border-accent/30 hover:text-accent">Load more</button>`
        : `<p class="text-xs text-ink-muted">That's everyone in this view.</p>`;
      const loadMoreBtn = paginationEl.querySelector('#load-more-btn');
      if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => loadList({ append: true }));
        attachRipple(loadMoreBtn);
      }
    }

    async function loadList({ append = false } = {}) {
      try {
        const result = await posApi.customers.list({
          search: searchTerm || null,
          cursor: append ? listCursor : null,
          limit: 20,
          filter: activeFilter,
        });
        listRows = append ? [...listRows, ...result.rows] : result.rows;
        listCursor = result.nextCursor;
        renderList(append);
      } catch (err) {
        toaster.error('Failed to load customers: ' + err.message);
      }
    }
    refreshList = loadList; // lets the top-level Add Customer handler (outside this closure) trigger a reload

    // Non-blocking: loaded alongside the list, then triggers one
    // re-render to attach "Possible Duplicate" badges once ready -
    // never holds up the list itself over this secondary check.
    async function loadDuplicates() {
      try {
        const groups = await posApi.customers.listDuplicates();
        duplicatePhoneSet = new Set(groups.map((g) => g.phoneNormalized));
        renderList();
      } catch (err) {
        console.error('Failed to check for duplicate customers', err);
      }
    }

    wireSearchBar(viewHost, (value) => {
      searchTerm = value;
      loadList();
    });

    loadList();
    loadDuplicates();
  }

  // ---------------------------------------------------------------
  // DETAIL VIEW - a single customer's profile: tenure, top items,
  // a spend chart, addresses, and their paginated order history.
  // ---------------------------------------------------------------
  function showDetail(customerId) {
    viewHost.innerHTML = `
      <header class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-8 py-5 md:px-12">
        <div class="flex items-center gap-3">
          <button type="button" id="back-btn"
            class="ripple-host flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-border text-ink-secondary hover:border-accent/30 hover:text-accent">
            <span class="h-4 w-4">${iconMarkup('chevronLeft')}</span>
          </button>
          <div>
            <h1 id="detail-name" class="font-display text-xl font-bold text-ink">&nbsp;</h1>
            <p id="detail-sub" class="text-sm text-ink-secondary">&nbsp;</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" id="edit-btn"
            class="ripple-host flex items-center gap-2 rounded-xl border border-border px-3.5 py-2 text-sm text-ink-secondary hover:border-accent/30 hover:text-accent">
            <span class="h-3.5 w-3.5">${iconMarkup('edit')}</span> Edit
          </button>
          <div class="relative">
            <button type="button" id="customer-menu-btn" title="More options"
              class="ripple-host flex h-9 w-9 items-center justify-center rounded-xl border border-border text-ink-secondary hover:border-accent/30 hover:text-accent">
              <span class="h-4 w-4">${iconMarkup('moreVertical')}</span>
            </button>
            <div id="customer-menu"
              class="hidden absolute right-0 top-full z-20 mt-1.5 w-48 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-modal">
              <button type="button" id="delete-customer-btn"
                class="ripple-host flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm font-medium text-red-600 hover:bg-red-50">
                <span class="h-3.5 w-3.5">${iconMarkup('trash')}</span> Delete Customer
              </button>
            </div>
          </div>
        </div>
      </header>

      <div id="edit-panel" class="hidden flex-wrap items-end gap-3 border-b border-border bg-surface-raised px-8 py-4 md:px-12">
        <label class="flex flex-col gap-1 text-xs text-ink-secondary">
          Name
          <input id="edit-name" class="rounded-lg border border-border px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-secondary">
          Phone
          <input id="edit-phone" class="rounded-lg border border-border px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
        </label>
        <button type="button" id="edit-save-btn" class="ripple-host rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">Save</button>
        <button type="button" id="edit-cancel-btn" class="ripple-host rounded-xl border border-border px-3.5 py-2 text-sm text-ink-secondary hover:bg-surface-raised">Cancel</button>
      </div>

      <div class="flex-1 overflow-y-auto px-8 py-6 md:px-12">
        <div id="stat-cards" class="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3"></div>

        <div class="mb-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <section class="rounded-2xl border border-border bg-surface p-5">
            <h2 class="mb-4 font-display text-sm font-bold text-ink">Top Buying Items</h2>
            <div id="top-items"></div>
          </section>
          <section class="rounded-2xl border border-border bg-surface p-5">
            <h2 class="mb-4 font-display text-sm font-bold text-ink">Spending, last 6 months</h2>
            <div id="spend-chart"></div>
          </section>
        </div>

        <section class="mb-6 rounded-2xl border border-border bg-surface p-5">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="font-display text-sm font-bold text-ink">Addresses</h2>
            <button type="button" id="add-address-btn"
              class="ripple-host rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">
              + Address
            </button>
          </div>
          <div id="address-list" class="flex flex-col gap-2"></div>
          <div id="address-form-host" class="mt-3 hidden flex-col gap-2"></div>
        </section>

        <section class="overflow-hidden rounded-2xl border border-border">
          <div class="border-b border-border bg-surface-raised px-5 py-3">
            <h2 class="font-display text-sm font-bold text-ink">Order History</h2>
          </div>
          <div id="detail-orders"></div>
          <div id="detail-pagination" class="flex justify-center border-t border-border py-4"></div>
        </section>
      </div>
    `;

    const backBtn = viewHost.querySelector('#back-btn');
    const editBtn = viewHost.querySelector('#edit-btn');
    const menuBtn = viewHost.querySelector('#customer-menu-btn');
    const menuEl = viewHost.querySelector('#customer-menu');
    const deleteBtn = viewHost.querySelector('#delete-customer-btn');
    const editPanel = viewHost.querySelector('#edit-panel');
    const editNameInput = viewHost.querySelector('#edit-name');
    const editPhoneInput = viewHost.querySelector('#edit-phone');
    const nameEl = viewHost.querySelector('#detail-name');
    const subEl = viewHost.querySelector('#detail-sub');
    const statCardsEl = viewHost.querySelector('#stat-cards');
    const topItemsEl = viewHost.querySelector('#top-items');
    const spendChartEl = viewHost.querySelector('#spend-chart');
    const addressListEl = viewHost.querySelector('#address-list');
    const addAddressBtn = viewHost.querySelector('#add-address-btn');
    const addressFormHost = viewHost.querySelector('#address-form-host');
    const ordersEl = viewHost.querySelector('#detail-orders');
    const detailPaginationEl = viewHost.querySelector('#detail-pagination');

    attachRipple(backBtn);
    attachRipple(editBtn);
    attachRipple(menuBtn);
    attachRipple(deleteBtn);
    attachRipple(viewHost.querySelector('#edit-cancel-btn'));
    attachRipple(viewHost.querySelector('#edit-save-btn'));
    attachRipple(addAddressBtn);

    backBtn.addEventListener('click', showList);

    function closeCustomerMenu() {
      menuEl.classList.add('hidden');
    }
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !menuEl.classList.contains('hidden');
      closeCustomerMenu();
      if (!isOpen) menuEl.classList.remove('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#customer-menu-btn') && !e.target.closest('#customer-menu')) {
        closeCustomerMenu();
      }
    });

    deleteBtn.addEventListener('click', async () => {
      closeCustomerMenu();
      const orderCount = currentStats?.order_count ?? 0;
      const historyNote = orderCount
        ? ` Their ${orderCount} past order${orderCount === 1 ? '' : 's'} will stay in Order History and Reports (still shown with the same name/phone/address), just no longer linked to a customer profile.`
        : '';
      const confirmed = await confirmAction({
        title: `Permanently delete "${currentCustomer.name}"?`,
        message: `This removes their profile and every saved address for good - it cannot be undone.${historyNote}`,
        confirmLabel: 'Delete customer',
        tone: 'danger',
        requireTypedConfirmation: currentCustomer.name,
      });
      if (!confirmed) return;
      try {
        await posApi.customers.remove(customerId);
        toaster.success(`"${currentCustomer.name}" was permanently deleted.`);
        showList();
      } catch (err) {
        toaster.error(err.message);
      }
    });

    let currentCustomer = null;
    let currentStats = null;
    let orderPage = 1;

    function renderHeader() {
      nameEl.textContent = currentCustomer.name;
      subEl.textContent = `${currentCustomer.phone} · ${tenureLabel(currentCustomer.created_at)}`;
    }

    editBtn.addEventListener('click', () => {
      editNameInput.value = currentCustomer?.name || '';
      editPhoneInput.value = currentCustomer?.phone || '';
      editPanel.classList.remove('hidden');
      editPanel.classList.add('flex');
    });
    viewHost.querySelector('#edit-cancel-btn').addEventListener('click', () => {
      editPanel.classList.add('hidden');
      editPanel.classList.remove('flex');
    });
    viewHost.querySelector('#edit-save-btn').addEventListener('click', async () => {
      try {
        const updated = await posApi.customers.update(customerId, {
          name: editNameInput.value.trim(),
          phone: editPhoneInput.value.trim(),
        });
        currentCustomer = { ...currentCustomer, ...updated };
        renderHeader();
        editPanel.classList.add('hidden');
        editPanel.classList.remove('flex');
        toaster.success('Customer updated.');
      } catch (err) {
        toaster.error(err.message);
      }
    });

    function renderAddresses() {
      const addresses = currentCustomer.addresses || [];
      addressListEl.innerHTML = addresses.length
        ? addresses
            .map(
              (a) => `
          <div class="flex items-center gap-2 text-sm text-ink-secondary">
            ${
              a.is_default
                ? `<span class="h-3.5 w-3.5 flex-shrink-0 text-accent">${iconMarkup('home')}</span>`
                : `<span class="h-3.5 w-3.5 flex-shrink-0 text-ink-muted">${iconMarkup('mapPin')}</span>`
            }
            ${a.label ? `<span class="font-medium text-ink">${a.label}:</span>` : ''}
            ${a.address}
          </div>`
            )
            .join('')
        : `<p class="text-sm text-ink-muted">No saved addresses yet.</p>`;
    }

    addAddressBtn.addEventListener('click', () => {
      const isHidden = addressFormHost.classList.contains('hidden');
      if (!isHidden) {
        addressFormHost.classList.add('hidden');
        addressFormHost.innerHTML = '';
        return;
      }
      addressFormHost.classList.remove('hidden');
      addressFormHost.classList.add('flex');
      addressFormHost.innerHTML = `
        <input placeholder="Label (e.g. Home, Office)" class="addr-label rounded-lg border border-border px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
        <textarea placeholder="Address" rows="2" class="addr-text rounded-lg border border-border px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"></textarea>
        <div class="flex gap-2">
          <button type="button" class="save-addr-btn ripple-host self-start rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover">Save address</button>
          <button type="button" class="cancel-addr-btn ripple-host self-start rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:bg-surface-raised">Cancel</button>
        </div>
      `;
      const saveBtn = addressFormHost.querySelector('.save-addr-btn');
      const cancelBtn = addressFormHost.querySelector('.cancel-addr-btn');
      attachRipple(saveBtn);
      attachRipple(cancelBtn);
      cancelBtn.addEventListener('click', () => {
        addressFormHost.classList.add('hidden');
        addressFormHost.innerHTML = '';
      });
      saveBtn.addEventListener('click', async () => {
        const label = addressFormHost.querySelector('.addr-label').value.trim() || null;
        const address = addressFormHost.querySelector('.addr-text').value.trim();
        if (!address) {
          toaster.error('Address text is required.');
          return;
        }
        try {
          const updated = await posApi.customers.addAddress(customerId, { label, address });
          currentCustomer = { ...currentCustomer, addresses: updated.addresses };
          renderAddresses();
          addressFormHost.classList.add('hidden');
          addressFormHost.innerHTML = '';
          toaster.success('Address added.');
        } catch (err) {
          toaster.error(err.message);
        }
      });
    });

    function detailOrderRow(order) {
      return `
        <tr class="border-t border-border">
          <td class="px-4 py-3">
            <div class="font-medium text-ink">#${order.id}</div>
            <div class="text-xs text-ink-muted">${order.order_type}</div>
          </td>
          <td class="px-4 py-3 text-ink-secondary">${formatTime(order.created_at)}</td>
          <td class="px-4 py-3 font-nums font-medium text-ink">${money(order.total)}</td>
          <td class="px-4 py-3">${statusBadge(order.status)}</td>
        </tr>`;
    }

    async function loadOrders() {
      try {
        const result = await posApi.orders.listByCustomer(customerId, { page: orderPage, pageSize: 8 });
        if (result.rows.length === 0) {
          ordersEl.innerHTML = `
            <div class="flex flex-col items-center justify-center gap-2 bg-surface-raised px-6 py-12 text-center">
              <span class="h-7 w-7 text-ink-muted">${iconMarkup('history')}</span>
              <p class="text-sm text-ink-secondary">No orders yet.</p>
            </div>`;
          detailPaginationEl.innerHTML = '';
          return;
        }
        ordersEl.innerHTML = `
          <table class="w-full text-left text-sm">
            <thead class="bg-surface-raised text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th class="px-4 py-3 font-medium">Order</th>
                <th class="px-4 py-3 font-medium">Time</th>
                <th class="px-4 py-3 font-medium">Total</th>
                <th class="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>${result.rows.map(detailOrderRow).join('')}</tbody>
          </table>`;

        if (result.totalPages > 1) {
          const nextPage = result.page < result.totalPages ? result.page + 1 : null;
          detailPaginationEl.innerHTML = `
            <div class="flex items-center gap-3 text-sm text-ink-secondary">
              <span>Page ${result.page} of ${result.totalPages}</span>
              ${
                nextPage
                  ? `<button type="button" id="detail-next-btn"
                       class="ripple-host rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">
                       View next page
                     </button>`
                  : ''
              }
            </div>`;
          const nextBtn = detailPaginationEl.querySelector('#detail-next-btn');
          if (nextBtn) {
            nextBtn.addEventListener('click', () => {
              orderPage = nextPage;
              loadOrders();
            });
            attachRipple(nextBtn);
          }
        } else {
          detailPaginationEl.innerHTML = '';
        }
      } catch (err) {
        toaster.error('Failed to load order history: ' + err.message);
      }
    }

    async function loadAll() {
      try {
        const [customer, stats] = await Promise.all([posApi.customers.get(customerId), posApi.customers.getStats(customerId)]);
        if (!customer) {
          toaster.error('Customer not found.');
          showList();
          return;
        }
        currentCustomer = customer;
        currentStats = stats;
        renderHeader();
        renderAddresses();

        statCardsEl.innerHTML = [
          statCard('Total Spent', money(stats.total_spent), 'chart'),
          statCard('Orders', String(stats.order_count), 'receipt'),
          statCard(
            'Customer Since',
            currentCustomer.created_at
              ? new Date(currentCustomer.created_at.replace(' ', 'T') + 'Z').toLocaleDateString([], { month: 'short', year: 'numeric' })
              : '—',
            'clock'
          ),
        ].join('');

        topItemsEl.innerHTML = renderHorizontalBars(
          stats.topItems.map((i) => ({ label: i.name, value: i.revenue, quantity: i.quantity })),
          {
            formatSublabel: (item) => `${item.quantity} sold &middot; ${money(item.value)}`,
            emptyMessage: 'No items purchased yet.',
          }
        );

        spendChartEl.innerHTML = renderBarChart(
          stats.monthlySpend.map((m) => ({ label: monthLabel(m.month), value: m.total })),
          { formatValue: money, emptyMessage: 'No sales yet.' }
        );

        await loadOrders();
      } catch (err) {
        toaster.error('Failed to load customer profile: ' + err.message);
      }
    }

    loadAll();
  }

  showList();

  // overlay lives on document.body (see the comment where it was built,
  // above), not inside `root` - so it isn't cleaned up automatically
  // when the router discards `root` on navigation. Remove it explicitly
  // here, or it leaks as an orphaned node, and a second one would be
  // appended on top of it next time this screen opens.
  root._cleanup = () => overlay.remove();

  return root;
}
