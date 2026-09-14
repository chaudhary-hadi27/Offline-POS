'use strict';

import { posApi } from '../shell/posApi.js';
import { iconMarkup } from '../shell/icons.js';
import { attachRipple, attachRippleAll } from '../shell/ripple.js';
import { toaster } from '../shell/toast.js';
import { printAndNotify } from './shared/printReceipt.js';
import { hydrateItemImages } from './shared/imageCache.js';
import { searchBarHtml, wireSearchBar } from '../shell/searchBar.js';

const ORDER_TYPES = ['Dine-In', 'Takeaway', 'Delivery'];

/** Full value, always - never abbreviated to "1.2K". Whole-rupee
 *  amounts (the overwhelming majority here) print without decimals
 *  ("Rs. 12,500") so the number stays compact even when it's large;
 *  a genuine fractional amount still prints its cents in full so
 *  nothing is silently rounded away. */
function money(n) {
  const num = Number(n) || 0;
  const hasFraction = Math.round(num * 100) % 100 !== 0;
  const formatted = num.toLocaleString('en-PK', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `Rs. ${formatted}`;
}

/** Re-orders the fresh category list to match a saved drag order (any new/unknown category is appended at the end). */
function applySavedCategoryOrder(freshCategories, savedOrderJson) {
  if (!savedOrderJson) return freshCategories;
  try {
    const saved = JSON.parse(savedOrderJson);
    if (!Array.isArray(saved)) return freshCategories;
    const known = new Set(freshCategories);
    const ordered = saved.filter((c) => known.has(c));
    const remaining = freshCategories.filter((c) => !ordered.includes(c));
    return [...ordered, ...remaining];
  } catch {
    return freshCategories;
  }
}

export function renderNewOrder() {
  const root = document.createElement('div');
  root.className = 'flex h-full w-full flex-col overflow-hidden bg-surface';
  root.innerHTML = `<div class="flex h-full w-full items-center justify-center text-sm text-ink-muted">Loading...</div>`;

  let cart = []; // [{ key, itemId, name, nameUrdu, unitPrice, quantity, imagePath }]
  let taxRate = 0;
  let deliveryCharge = 0;
  // Cashier override for THIS order's delivery fee - null means "use the
  // default from Settings > Restaurant & Receipt" (deliveryCharge above).
  // Set once the cashier edits the field in the cart, same idea as a
  // line's custom unitPrice overriding the menu price.
  let deliveryChargeOverride = null;
  let orderType = 'Dine-In';
  let lastOrderId = null;
  let activeCategory = 'All';
  let menuSearchTerm = '';
  let menuItems = [];
  let categories = [];

  function computeTotals() {
    const subtotal = cart.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
    const taxAmount = +(subtotal * (taxRate / 100)).toFixed(2);
    // Delivery charge (Settings > Restaurant & Receipt) only applies
    // when the cashier has picked "Delivery" - Dine-In/Takeaway orders
    // never carry it, same as tax only applying once there's a cart.
    const deliveryFee = orderType === 'Delivery' ? (deliveryChargeOverride ?? deliveryCharge) : 0;
    const total = +(subtotal + taxAmount + deliveryFee).toFixed(2);
    return { subtotal, taxAmount, deliveryFee, total };
  }

  function addToCart(item, variant = null, qty = 1) {
    const key = variant ? `${item.id}::${variant.label}` : String(item.id);
    const existing = cart.find((l) => l.key === key);
    if (existing) {
      existing.quantity += qty;
    } else {
      cart.push({
        key,
        itemId: item.id,
        name: variant ? `${item.name} (${variant.label})` : item.name,
        nameUrdu: item.name_urdu
          ? (variant ? `${item.name_urdu} (${variant.label})` : item.name_urdu)
          : null,
        unitPrice: variant ? variant.price : item.price,
        quantity: qty,
        imagePath: item.image_path || null,
      });
    }
    renderCart();
  }

  function setQuantity(key, quantity) {
    if (quantity <= 0) {
      cart = cart.filter((l) => l.key !== key);
    } else {
      const line = cart.find((l) => l.key === key);
      if (line) line.quantity = quantity;
    }
    renderCart();
  }

  function removeLine(key) {
    cart = cart.filter((l) => l.key !== key);
    renderCart();
  }

  function setCustomPrice(key, price) {
    const line = cart.find((l) => l.key === key);
    if (line && Number.isFinite(price) && price >= 0) line.unitPrice = price;
    renderCart();
  }

  function setDeliveryChargeOverride(amount) {
    deliveryChargeOverride = amount;
    renderCart();
  }

  function clearCart() {
    if (cart.length === 0) return;
    cart = [];
    deliveryChargeOverride = null;
    renderCart();
    toaster.show('Cart cleared.', { duration: 1600 });
  }

  function buildLayout() {
    root.innerHTML = `
      <div class="flex h-full w-full overflow-hidden">
        <section class="flex h-full flex-1 flex-col overflow-hidden border-r border-border">
          <header class="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
            <div>
              <h1 class="font-display text-lg font-bold text-ink">New Order</h1>
              <p class="text-xs text-ink-secondary">Tap an item to add it to the cart</p>
            </div>
            <div class="w-56">${searchBarHtml({ placeholder: 'Search menu', id: 'menu-order-search' })}</div>
          </header>
          <div id="menu-tabs" class="flex flex-wrap gap-2 border-b border-border px-6 py-3"></div>
          <div id="menu-grid" class="flex-1 overflow-y-auto px-6 py-5"></div>
        </section>

        <aside class="flex h-full w-[400px] flex-shrink-0 flex-col overflow-hidden bg-surface-raised">
          <div class="border-b border-border p-5">
            <div id="order-type-buttons" class="grid grid-cols-3 gap-2"></div>
            <div id="customer-fields" class="mt-4 flex flex-col gap-2.5"></div>
          </div>

          <div id="cart-lines" class="flex-1 overflow-y-auto p-5"></div>

          <div class="border-t border-border bg-surface p-5">
            <div id="cart-totals" class="mb-4 flex flex-col gap-1.5 text-sm"></div>
            <button type="button" id="submit-order-btn"
              class="ripple-host w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white shadow-card transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-border-strong disabled:text-ink-muted">
              Complete Order
            </button>
          </div>
        </aside>
      </div>
    `;

    setupGridAutoScroll(root.querySelector('#menu-grid'));
    renderOrderTypeButtons();
    renderCustomerFields();
    renderMenu();
    renderCart();

    wireSearchBar(root, (value) => {
      menuSearchTerm = value;
      renderMenuGrid();
    });

    root.querySelector('#submit-order-btn').addEventListener('click', submitOrder);
    attachRipple(root.querySelector('#submit-order-btn'));
  }

  function renderOrderTypeButtons() {
    const container = root.querySelector('#order-type-buttons');
    container.innerHTML = ORDER_TYPES.map(
      (type) => `
      <button type="button" data-type="${type}"
        class="type-btn ripple-host rounded-xl border px-2 py-2.5 text-xs font-medium transition-colors
               ${type === orderType ? 'border-accent bg-accent/10 text-accent' : 'border-border text-ink-secondary hover:border-accent/30'}">
        ${type}
      </button>`
    ).join('');
    container.querySelectorAll('.type-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        orderType = btn.dataset.type;
        renderOrderTypeButtons();
        renderCustomerFields();
        renderCart(); // delivery charge line only shows for Delivery, so totals must recompute here too
      });
    });
    attachRippleAll(container, '.type-btn');
  }

  let customerMatchDebounce = null;
  let importedCustomerId = null; // set once an import/exact-match has been applied, so we stop nagging

  /** Mirrors electron/utils/phone.js - used here only to tell whether
   *  a typed number is genuinely a different customer before offering
   *  to import it (so "0300 1234567" vs "03001234567" don't count as
   *  two different matches). */
  function normalizePhone(raw) {
    if (!raw) return '';
    let digits = String(raw).replace(/\D+/g, '');
    if (!digits) return '';
    digits = digits.replace(/^0092/, '').replace(/^92/, '').replace(/^0/, '');
    return digits ? `92${digits}` : '';
  }

  function renderCustomerFields(preserveValues = true) {
    const container = root.querySelector('#customer-fields');
    const prevName = preserveValues ? (container.querySelector('[name="customerName"]')?.value ?? '') : '';
    const prevPhone = preserveValues ? (container.querySelector('[name="customerPhone"]')?.value ?? '') : '';
    const prevAddress = preserveValues ? (container.querySelector('[name="customerAddress"]')?.value ?? '') : '';
    if (!preserveValues) importedCustomerId = null;

    container.innerHTML = `
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-ink-secondary">Customer</span>
        <button type="button" id="customer-search-toggle" title="Find existing customer"
          class="ripple-host flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-surface hover:text-accent">
          <span class="h-4 w-4">${iconMarkup('search')}</span>
        </button>
      </div>
      <div id="customer-search-wrap" class="search-collapse">
        <div class="flex flex-col gap-1.5 pb-2.5">
          <input type="text" id="customer-search-input" autocomplete="off" placeholder="Search by name or phone number"
            class="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
          <div id="customer-search-results" class="hidden flex-col gap-1 overflow-y-auto rounded-lg border border-border bg-surface p-1.5 shadow-card" style="max-height: 208px;"></div>
        </div>
      </div>
      <input name="customerName" autocomplete="off" placeholder="Customer name (optional)" value="${prevName}"
        class="rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
      <input name="customerPhone" autocomplete="off" placeholder="Phone number (optional)" value="${prevPhone}"
        class="rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
      <div id="customer-match" class="hidden flex-col gap-1.5"></div>
      ${
        orderType === 'Delivery'
          ? `<textarea name="customerAddress" placeholder="Delivery address (required)" rows="2"
               class="rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20">${prevAddress}</textarea>`
          : ''
      }
    `;

    const nameInput = container.querySelector('[name="customerName"]');
    const phoneInput = container.querySelector('[name="customerPhone"]');
    const matchEl = container.querySelector('#customer-match');
    const searchToggle = container.querySelector('#customer-search-toggle');
    const searchWrap = container.querySelector('#customer-search-wrap');
    const searchInput = container.querySelector('#customer-search-input');
    const searchResults = container.querySelector('#customer-search-results');
    attachRipple(searchToggle);

    function closeCustomerSearch() {
      searchWrap.classList.remove('is-open');
      searchInput.value = '';
      searchResults.classList.add('hidden');
      searchResults.classList.remove('flex');
      searchResults.innerHTML = '';
    }

    searchToggle.addEventListener('click', () => {
      const opening = !searchWrap.classList.contains('is-open');
      searchWrap.classList.toggle('is-open', opening);
      if (opening) {
        // Wait for the expand transition to actually finish before
        // focusing - focusing mid-transition on a still-growing
        // container can yank the page scroll position around.
        setTimeout(() => searchInput.focus(), 220);
      } else {
        closeCustomerSearch();
      }
    });

    // Debounced, server-side search (never fetches the whole customer
    // table into the renderer) - stays fast whether there are 20
    // customers on file or 5,000, and a stale response that lands
    // after a newer one is dropped so fast typing never flashes an
    // out-of-date result list.
    let searchDebounce = null;
    let searchRequestId = 0;
    searchInput.addEventListener('input', () => {
      const term = searchInput.value.trim();
      clearTimeout(searchDebounce);
      if (!term) {
        searchResults.classList.add('hidden');
        searchResults.classList.remove('flex');
        searchResults.innerHTML = '';
        return;
      }
      searchDebounce = setTimeout(async () => {
        const requestId = ++searchRequestId;
        try {
          const { rows } = await posApi.customers.list({ search: term, limit: 8 });
          if (requestId !== searchRequestId) return; // a newer keystroke's search already superseded this one
          if (rows.length === 0) {
            searchResults.classList.remove('hidden');
            searchResults.classList.add('flex');
            searchResults.innerHTML = `<p class="px-2 py-2 text-xs text-ink-muted">No matching customers.</p>`;
            return;
          }
          searchResults.classList.remove('hidden');
          searchResults.classList.add('flex');
          searchResults.innerHTML = rows
            .map(
              (c) => `
              <button type="button" data-customer-id="${c.id}"
                class="customer-result-btn ripple-host flex flex-col items-start rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-accent/10">
                <span class="font-medium text-ink">${c.name}</span>
                <span class="text-ink-muted">${c.phone}</span>
              </button>`
            )
            .join('');
          searchResults.querySelectorAll('.customer-result-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
              const customer = rows.find((c) => c.id === Number(btn.dataset.customerId));
              if (customer) {
                applyImport(customer);
                closeCustomerSearch();
              }
            });
          });
          attachRippleAll(searchResults, '.customer-result-btn');
        } catch (err) {
          console.error('[new-order] customer search failed (non-blocking)', err);
        }
      }, 250);
    });

    function applyImport(customer) {
      nameInput.value = customer.name;
      phoneInput.value = customer.phone;
      const addressInput = container.querySelector('[name="customerAddress"]');
      if (addressInput) {
        const defaultAddr = (customer.addresses || []).find((a) => a.is_default) || (customer.addresses || [])[0];
        if (defaultAddr) addressInput.value = defaultAddr.address;
      }
      importedCustomerId = customer.id;
      matchEl.classList.add('hidden');
      matchEl.innerHTML = '';
      toaster.show(`Imported "${customer.name}" from your customer records.`, { duration: 1800 });
    }

    // Import suggestions are driven ENTIRELY by the phone number field -
    // typing a name never triggers this (a name match is too weak a
    // signal and was popping up the "Import" button for unrelated
    // customers who just share a common name). It only fires once a
    // full number has actually been typed, not on every keystroke.
    async function checkForMatches() {
      const phoneVal = phoneInput.value.trim();
      const phoneDigits = phoneVal.replace(/\D+/g, '');

      if (importedCustomerId && phoneVal === (matchEl.dataset.lastPhone || '')) {
        return; // already imported this exact record - no need to suggest it back
      }
      if (phoneDigits.length < 10) {
        matchEl.classList.add('hidden');
        matchEl.innerHTML = '';
        return;
      }

      try {
        const { rows } = await posApi.customers.list({ search: phoneVal, limit: 3 });
        const typedNormalized = normalizePhone(phoneVal);
        const matches = rows.filter((c) => c.id !== importedCustomerId && normalizePhone(c.phone) !== typedNormalized);

        if (matches.length === 0) {
          matchEl.classList.add('hidden');
          matchEl.innerHTML = '';
          return;
        }

        matchEl.classList.remove('hidden');
        matchEl.classList.add('flex');
        matchEl.innerHTML = matches
          .map(
            (c) => `
            <button type="button" data-import-id="${c.id}"
              class="import-btn ripple-host flex items-center justify-between gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-1.5 text-left text-xs text-accent transition-colors hover:bg-accent/10">
              <span class="truncate">Import <span class="font-medium">${c.name}</span> &middot; ${c.phone}</span>
              <span class="flex-shrink-0 font-medium">Use</span>
            </button>`
          )
          .join('');
        matchEl.querySelectorAll('.import-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            const customer = matches.find((c) => c.id === Number(btn.dataset.importId));
            if (customer) {
              matchEl.dataset.lastPhone = customer.phone;
              applyImport(customer);
            }
          });
        });
        attachRippleAll(matchEl, '.import-btn');
      } catch (err) {
        console.error('[new-order] customer match lookup failed (non-blocking)', err);
      }
    }

    nameInput.addEventListener('input', () => {
      importedCustomerId = null;
    });
    phoneInput.addEventListener('input', () => {
      importedCustomerId = null;
      clearTimeout(customerMatchDebounce);
      customerMatchDebounce = setTimeout(checkForMatches, 300);
    });
  }

  /** Persists the current `categories` order so tab drag-reorders survive a refresh. */
  async function saveCategoryOrder() {
    try {
      await posApi.settings.set({ menu_category_order: JSON.stringify(categories) });
    } catch (err) {
      console.error('[new-order] failed to save category order (non-blocking)', err);
    }
  }

  function renderMenuTabs() {
    const tabsEl = root.querySelector('#menu-tabs');
    const tabs = ['All', ...categories];
    tabsEl.innerHTML = tabs
      .map(
        (cat) => `
        <button type="button" data-category="${cat}" ${cat === 'All' ? '' : 'draggable="true"'}
          class="tab-btn ripple-host rounded-full border px-3 py-1.5 text-xs transition-colors ${cat === 'All' ? '' : 'cursor-grab active:cursor-grabbing'}
                 ${cat === activeCategory ? 'border-accent bg-accent/10 text-accent' : 'border-border text-ink-secondary hover:border-accent/30'}">
          ${cat}
        </button>`
      )
      .join('');
    tabsEl.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeCategory = btn.dataset.category;
        renderMenuTabs();
        renderMenuGrid();
      });
    });
    attachRippleAll(tabsEl, '.tab-btn');

    // Drag a category tab left/right to reorder it. "All" is a fixed
    // pseudo-tab (not a real category) so it's excluded from dragging.
    let draggedCategory = null;
    tabsEl.querySelectorAll('.tab-btn[draggable="true"]').forEach((btn) => {
      btn.addEventListener('dragstart', (e) => {
        draggedCategory = btn.dataset.category;
        e.dataTransfer.effectAllowed = 'move';
        btn.classList.add('opacity-40');
      });
      btn.addEventListener('dragend', () => btn.classList.remove('opacity-40'));
      btn.addEventListener('dragover', (e) => {
        e.preventDefault();
        btn.classList.add('ring-2', 'ring-accent/50');
      });
      btn.addEventListener('dragleave', () => btn.classList.remove('ring-2', 'ring-accent/50'));
      btn.addEventListener('drop', (e) => {
        e.preventDefault();
        btn.classList.remove('ring-2', 'ring-accent/50');
        const targetCategory = btn.dataset.category;
        if (!draggedCategory || draggedCategory === targetCategory) return;
        const from = categories.indexOf(draggedCategory);
        const to = categories.indexOf(targetCategory);
        if (from === -1 || to === -1) return;
        categories.splice(from, 1);
        categories.splice(to, 0, draggedCategory);
        renderMenuTabs();
        saveCategoryOrder();
      });
    });
  }

  function menuCardThumb(item) {
    if (!item.image_path) {
      return `<span class="flex aspect-square w-full items-center justify-center rounded-lg bg-surface-raised text-ink-muted">
                <span class="h-6 w-6">${iconMarkup('utensils')}</span>
              </span>`;
    }
    return `<img data-image-path="${item.image_path}" alt="" class="aspect-square w-full rounded-lg object-cover opacity-0 transition-opacity duration-200 bg-surface-raised" />`;
  }

  function menuCardPriceLine(item) {
    const variants = item.priceVariants || [];
    if (variants.length === 0) return `<p class="font-nums text-sm text-accent">${money(item.price)}</p>`;
    const min = Math.min(...variants.map((v) => v.price));
    return `<p class="font-nums text-xs text-accent">${variants.length} options from ${money(min)}</p>`;
  }

  /**
   * Auto-scrolls the menu grid while a card is being dragged near the
   * top or bottom edge, so an item can be dragged all the way up (or
   * down) past whatever is currently in view instead of getting stuck
   * at the visible edge of the scroll area.
   */
  function setupGridAutoScroll(gridEl) {
    const EDGE = 70; // px from top/bottom that starts scrolling
    const MAX_SPEED = 18; // px per dragover tick at the very edge
    gridEl.addEventListener('dragover', (e) => {
      const rect = gridEl.getBoundingClientRect();
      const distFromTop = e.clientY - rect.top;
      const distFromBottom = rect.bottom - e.clientY;
      if (distFromTop < EDGE) {
        gridEl.scrollTop -= MAX_SPEED * (1 - Math.max(distFromTop, 0) / EDGE);
      } else if (distFromBottom < EDGE) {
        gridEl.scrollTop += MAX_SPEED * (1 - Math.max(distFromBottom, 0) / EDGE);
      }
    });
  }

  /** Persists the current global `menuItems` order after a drag-reorder in the grid. */
  async function saveItemOrder() {
    try {
      await posApi.items.reorder(menuItems.map((i) => i.id));
    } catch (err) {
      console.error('[new-order] failed to save item order (non-blocking)', err);
    }
  }

  /**
   * Read-only-ish detail popup opened by tapping anywhere on a menu
   * card (except the "+" button). Blurred backdrop, full description,
   * and its own quantity + Add to Cart controls so a click-through
   * customer never accidentally adds an item just by viewing it.
   */
  function openItemDetail(item) {
    let selectedVariant = item.priceVariants?.length ? item.priceVariants[0] : null;
    let qty = 1;
    const hasDescription = !!(item.description && item.description.trim());

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-40 flex items-center justify-center p-4';
    overlay.innerHTML = `
      <div class="item-detail-scrim scrim-enter absolute inset-0 bg-black/60 backdrop-blur-md"></div>
      <div class="modal-pop relative flex w-full max-w-sm flex-col rounded-2xl border border-border bg-surface shadow-modal">
        <div class="relative overflow-hidden rounded-t-2xl">
          ${
            item.image_path
              ? `<img data-image-path="${item.image_path}" alt="" class="aspect-square w-full object-cover opacity-0 transition-opacity duration-200 bg-surface-raised" />`
              : `<div class="flex aspect-square w-full items-center justify-center bg-surface-raised text-ink-muted"><span class="h-8 w-8">${iconMarkup('utensils')}</span></div>`
          }
        </div>
        <button type="button" id="item-detail-close" title="Close"
          style="position: absolute; top: 1rem; right: 1rem; z-index: 10;"
          class="ripple-host flex h-9 w-9 items-center justify-center rounded-full bg-ink/70 text-white shadow-modal ring-2 ring-white/80 backdrop-blur-sm hover:bg-ink/90">
          <span class="h-4 w-4">${iconMarkup('close')}</span>
        </button>

        <div class="flex max-h-[70vh] flex-col gap-4 overflow-y-auto p-5">
          <div>
            <p class="text-[11px] uppercase tracking-wide text-ink-muted">${item.category}</p>
            <h3 class="font-display text-lg font-bold text-ink">${item.name}</h3>
            ${!item.is_available ? '<p class="mt-0.5 text-xs font-medium text-ink-muted">Currently out of stock</p>' : ''}
          </div>

          <p class="text-sm leading-relaxed text-ink-secondary">
            ${hasDescription ? item.description : '<span class="text-ink-muted">No description added for this item.</span>'}
          </p>

          ${
            item.priceVariants?.length
              ? `<div class="flex flex-col gap-2">
                  <span class="text-xs font-medium text-ink-secondary">Choose a price option</span>
                  <div id="item-detail-variants" class="flex flex-col gap-2">
                    ${item.priceVariants
                      .map(
                        (v, i) => `
                      <button type="button" data-variant-label="${v.label}"
                        class="detail-variant-option ripple-host flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm transition-colors
                               ${i === 0 ? 'border-accent bg-accent/10 text-accent' : 'border-border text-ink hover:border-accent/40 hover:bg-accent/5'}">
                        <span>${v.label}</span>
                        <span class="font-nums font-medium">${money(v.price)}</span>
                      </button>`
                      )
                      .join('')}
                  </div>
                </div>`
              : `<p class="font-nums text-xl font-bold text-accent">${money(item.price)}</p>`
          }

          <div class="flex items-center justify-between rounded-xl border border-border p-2">
            <span class="pl-1 text-sm font-medium text-ink-secondary">Quantity</span>
            <div class="flex items-center gap-2">
              <button type="button" id="item-detail-qty-minus"
                class="ripple-host flex h-8 w-8 items-center justify-center rounded-lg border border-border text-ink-secondary hover:border-accent/40 hover:text-accent">-</button>
              <input id="item-detail-qty" type="number" min="1" step="1" value="1"
                title="Click to type a custom quantity"
                class="w-12 rounded-lg border border-transparent bg-transparent text-center font-nums text-sm text-ink hover:border-border focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20" />
              <button type="button" id="item-detail-qty-plus"
                class="ripple-host flex h-8 w-8 items-center justify-center rounded-lg border border-border text-ink-secondary hover:border-accent/40 hover:text-accent">+</button>
            </div>
          </div>

          <button type="button" id="item-detail-add" ${item.is_available ? '' : 'disabled'}
            class="ripple-host w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white shadow-card transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-border-strong disabled:text-ink-muted">
            Add to Cart
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    hydrateItemImages(overlay);

    function close() {
      overlay.remove();
    }
    overlay.querySelector('.item-detail-scrim').addEventListener('click', close);
    overlay.querySelector('#item-detail-close').addEventListener('click', close);
    attachRipple(overlay.querySelector('#item-detail-close'));

    const qtyInput = overlay.querySelector('#item-detail-qty');
    function setQty(n) {
      qty = Math.max(1, Math.floor(n) || 1);
      qtyInput.value = qty;
    }
    overlay.querySelector('#item-detail-qty-minus').addEventListener('click', () => setQty(qty - 1));
    overlay.querySelector('#item-detail-qty-plus').addEventListener('click', () => setQty(qty + 1));
    qtyInput.addEventListener('change', () => setQty(Number(qtyInput.value)));
    qtyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') qtyInput.blur();
    });

    if (item.priceVariants?.length) {
      overlay.querySelectorAll('.detail-variant-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectedVariant = item.priceVariants.find((v) => v.label === btn.dataset.variantLabel);
          overlay.querySelectorAll('.detail-variant-option').forEach((b) => {
            const isSelected = b === btn;
            b.classList.toggle('border-accent', isSelected);
            b.classList.toggle('bg-accent/10', isSelected);
            b.classList.toggle('text-accent', isSelected);
            b.classList.toggle('border-border', !isSelected);
            b.classList.toggle('text-ink', !isSelected);
          });
        });
      });
      attachRippleAll(overlay, '.detail-variant-option');
    }

    overlay.querySelector('#item-detail-add')?.addEventListener('click', () => {
      addToCart(item, selectedVariant, qty);
      close();
    });
    attachRippleAll(overlay, '.ripple-host');
  }

  function renderMenuGrid() {
    const gridEl = root.querySelector('#menu-grid');
    let visible = activeCategory === 'All' ? menuItems : menuItems.filter((i) => i.category === activeCategory);
    if (menuSearchTerm) {
      const q = menuSearchTerm.toLowerCase();
      visible = visible.filter((i) => i.name.toLowerCase().includes(q));
    }

    if (visible.length === 0) {
      gridEl.innerHTML = `<p class="px-2 py-10 text-center text-sm text-ink-muted">${menuItems.length === 0 ? 'No items in this category.' : 'No items match your search.'}</p>`;
      return;
    }

    gridEl.innerHTML = `
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        ${visible
          .map(
            (item) => `
          <div data-card-id="${item.id}" draggable="true"
            class="menu-card group flex cursor-pointer flex-col gap-2 rounded-xl border border-border bg-surface p-2.5 transition-all
                   ${item.is_available ? 'hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-card-hover' : 'opacity-45'}">
            ${menuCardThumb(item)}
            <div class="flex items-center gap-2">
              <div class="min-w-0 flex-1 px-0.5">
                <p class="truncate text-sm font-medium text-ink">${item.name}</p>
                ${menuCardPriceLine(item)}
                ${!item.is_available ? '<p class="text-[11px] text-ink-muted">Out of stock</p>' : ''}
              </div>
              <button type="button" data-add-id="${item.id}" ${item.is_available ? '' : 'disabled'} title="Add to cart"
                class="add-btn ripple-host flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-card transition-transform hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:bg-border-strong">
                <span class="text-lg leading-none">+</span>
              </button>
            </div>
          </div>`
          )
          .join('')}
      </div>
    `;

    hydrateItemImages(gridEl);

    // The "+" button is the ONLY way to add to the cart. For a
    // single-price item it adds straight away. For a multi-price item
    // it opens the SAME detail popup the card itself opens (photo +
    // description + price options + qty) instead of a bare price list,
    // so the "+" and "click the card" paths always look identical for
    // multi-price items - only single-price items skip the popup.
    gridEl.querySelectorAll('.add-btn:not(:disabled)').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = menuItems.find((i) => i.id === Number(btn.dataset.addId));
        if (!item) return;
        if (item.priceVariants?.length) openItemDetail(item);
        else addToCart(item);
      });
    });

    // Clicking anywhere else on the card opens the read-only detail
    // popup (photo + description) with a blurred backdrop - it never
    // adds to the cart by itself.
    gridEl.querySelectorAll('.menu-card').forEach((card) => {
      const item = menuItems.find((i) => i.id === Number(card.dataset.cardId));
      if (!item) return;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.add-btn')) return;
        openItemDetail(item);
      });
    });
    attachRippleAll(gridEl, '.add-btn:not(:disabled)');

    // Drag a card left/right/up/down to reorder the whole menu. The
    // dragged item is re-spliced into the FULL menuItems array (not
    // just the filtered/visible list) so category filters and search
    // never scramble the order of items outside the current view.
    let draggedId = null;
    gridEl.querySelectorAll('.menu-card').forEach((card) => {
      card.addEventListener('dragstart', (e) => {
        draggedId = Number(card.dataset.cardId);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('opacity-40');
      });
      card.addEventListener('dragend', () => card.classList.remove('opacity-40'));
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        card.classList.add('ring-2', 'ring-accent/50');
      });
      card.addEventListener('dragleave', () => card.classList.remove('ring-2', 'ring-accent/50'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('ring-2', 'ring-accent/50');
        const targetId = Number(card.dataset.cardId);
        if (!draggedId || draggedId === targetId) return;
        const fromIdx = menuItems.findIndex((i) => i.id === draggedId);
        const toIdx = menuItems.findIndex((i) => i.id === targetId);
        if (fromIdx === -1 || toIdx === -1) return;
        const [moved] = menuItems.splice(fromIdx, 1);
        menuItems.splice(menuItems.findIndex((i) => i.id === targetId) + (fromIdx < toIdx ? 1 : 0), 0, moved);
        renderMenuGrid();
        saveItemOrder();
      });
    });
  }

  function renderMenu() {
    renderMenuTabs();
    renderMenuGrid();
  }

  function cartThumb(line) {
    if (!line.imagePath) {
      return `<span class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-surface text-ink-muted">
                <span class="h-4 w-4">${iconMarkup('utensils')}</span>
              </span>`;
    }
    return `<img data-image-path="${line.imagePath}" alt="" class="h-10 w-10 flex-shrink-0 rounded-lg object-cover opacity-0 transition-opacity duration-200 bg-surface" />`;
  }

  function renderCart() {
    const linesEl = root.querySelector('#cart-lines');
    const totalsEl = root.querySelector('#cart-totals');
    const submitBtn = root.querySelector('#submit-order-btn');

    if (cart.length === 0) {
      linesEl.innerHTML = `
        <div class="flex h-full flex-col items-center justify-center gap-2 text-center">
          <span class="h-8 w-8 text-ink-muted">${iconMarkup('receipt')}</span>
          <p class="text-sm text-ink-muted">Cart is empty</p>
        </div>`;
    } else {
      linesEl.innerHTML = cart
        .map(
          (line) => `
        <div class="cart-line-enter mb-2.5 flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
          <div class="flex items-center gap-2.5">
            ${cartThumb(line)}
            <p class="min-w-0 flex-1 truncate text-sm font-medium text-ink" title="${line.name}">${line.name}</p>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex min-w-0 flex-wrap items-center gap-1.5">
              <div class="flex flex-shrink-0 items-center gap-1 rounded-lg border border-border bg-surface-raised px-2 py-1.5">
                <span class="text-[11px] text-ink-muted">Rs.</span>
                <input type="number" min="0" step="0.01" data-price-key="${line.key}" value="${line.unitPrice}"
                  title="Custom price for this order"
                  class="w-14 bg-transparent text-right font-nums text-xs text-ink-secondary focus:outline-none" />
              </div>
              <div class="flex flex-shrink-0 items-center gap-1">
                <button type="button" data-qty-minus="${line.key}" class="ripple-host flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-border text-ink-secondary hover:border-accent/40 hover:text-accent">-</button>
                <input type="number" min="1" step="1" data-qty-key="${line.key}" value="${line.quantity}"
                  title="Click to type a custom quantity"
                  class="w-10 flex-shrink-0 rounded-md border border-border bg-surface-raised px-1 py-1.5 text-center font-nums text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20" />
                <button type="button" data-qty-plus="${line.key}" class="ripple-host flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-border text-ink-secondary hover:border-accent/40 hover:text-accent">+</button>
              </div>
            </div>
            <div class="flex flex-shrink-0 items-center gap-2">
              <p class="font-nums text-xs font-medium text-ink-muted">${money(line.unitPrice * line.quantity)}</p>
              <button type="button" data-remove-key="${line.key}" title="Remove from cart"
                class="ripple-host flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-accent/10 hover:text-accent">
                <span class="h-3.5 w-3.5">${iconMarkup('close')}</span>
              </button>
            </div>
          </div>
        </div>`
        )
        .join('');

      hydrateItemImages(linesEl);

      linesEl.querySelectorAll('[data-qty-minus]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.qtyMinus;
          const line = cart.find((l) => l.key === key);
          if (line) setQuantity(key, line.quantity - 1);
        });
      });
      linesEl.querySelectorAll('[data-qty-plus]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.qtyPlus;
          const line = cart.find((l) => l.key === key);
          if (line) setQuantity(key, line.quantity + 1);
        });
      });
      linesEl.querySelectorAll('[data-qty-key]').forEach((input) => {
        input.addEventListener('focus', () => input.select());
        const commit = () => {
          const qty = Math.floor(Number(input.value));
          if (!Number.isFinite(qty) || qty < 0) {
            const line = cart.find((l) => l.key === input.dataset.qtyKey);
            input.value = line ? line.quantity : 1;
            return;
          }
          setQuantity(input.dataset.qtyKey, qty);
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') input.blur();
        });
      });
      linesEl.querySelectorAll('[data-remove-key]').forEach((btn) => {
        btn.addEventListener('click', () => removeLine(btn.dataset.removeKey));
      });
      linesEl.querySelectorAll('[data-price-key]').forEach((input) => {
        let originalValue = input.value;
        input.addEventListener('focus', () => (originalValue = input.value));
        input.addEventListener('blur', () => {
          const price = Number(input.value);
          if (!Number.isFinite(price) || price < 0) {
            input.value = originalValue;
            return;
          }
          if (String(price) !== originalValue) setCustomPrice(input.dataset.priceKey, price);
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') input.blur();
        });
      });
      attachRippleAll(linesEl, '.ripple-host');
    }

    const { subtotal, taxAmount, deliveryFee, total } = computeTotals();
    totalsEl.innerHTML = `
      <div class="flex justify-between text-ink-secondary"><span>Subtotal</span><span class="font-nums">${money(subtotal)}</span></div>
      <div class="flex justify-between text-ink-secondary"><span>Tax (${taxRate}%)</span><span class="font-nums">${money(taxAmount)}</span></div>
      ${
        orderType === 'Delivery'
          ? `<div class="flex items-center justify-between text-ink-secondary">
               <span>Delivery Charge</span>
               <span class="flex items-center gap-1 rounded-lg border border-border bg-surface-raised px-2 py-1">
                 <span class="text-[11px] text-ink-muted">Rs.</span>
                 <input type="number" min="0" step="0.01" id="delivery-charge-input" value="${deliveryFee}"
                   title="Override the default delivery charge for this order"
                   class="w-14 bg-transparent text-right font-nums text-xs text-ink-secondary focus:outline-none" />
               </span>
             </div>`
          : ''
      }
      <div class="flex justify-between border-t border-border pt-1.5 text-base font-bold text-ink"><span>Total</span><span class="font-nums">${money(total)}</span></div>
    `;
    submitBtn.disabled = cart.length === 0;

    const deliveryInput = totalsEl.querySelector('#delivery-charge-input');
    if (deliveryInput) {
      let originalValue = deliveryInput.value;
      deliveryInput.addEventListener('focus', () => {
        originalValue = deliveryInput.value;
        deliveryInput.select();
      });
      deliveryInput.addEventListener('blur', () => {
        const amount = Number(deliveryInput.value);
        if (!Number.isFinite(amount) || amount < 0) {
          deliveryInput.value = originalValue;
          return;
        }
        if (String(amount) !== originalValue) setDeliveryChargeOverride(amount);
      });
      deliveryInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') deliveryInput.blur();
      });
    }
  }

  async function submitOrder() {
    const submitBtn = root.querySelector('#submit-order-btn');
    const customerName = root.querySelector('[name="customerName"]')?.value.trim() || null;
    const customerPhone = root.querySelector('[name="customerPhone"]')?.value.trim() || null;
    const customerAddress = root.querySelector('[name="customerAddress"]')?.value.trim() || null;

    if (orderType === 'Delivery' && !customerAddress) {
      toaster.error('Delivery address is required for delivery orders.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      let customerId = null;
      if (customerPhone && customerName) {
        try {
          const customer = await posApi.customers.upsert({ name: customerName, phone: customerPhone });
          customerId = customer.id;
          if (customerAddress) {
            await posApi.customers.addAddress(customer.id, { address: customerAddress, isDefault: true });
          }
        } catch (err) {
          console.error('[new-order] customer upsert failed (non-blocking)', err);
        }
      }

      const { deliveryFee } = computeTotals();
      const order = await posApi.orders.create({
        orderType,
        customerId,
        customerName,
        customerPhone,
        customerAddress,
        taxRate,
        deliveryCharge: deliveryFee,
        lines: cart.map((l) => ({ itemId: l.itemId, name: l.name, nameUrdu: l.nameUrdu, quantity: l.quantity, unitPrice: l.unitPrice })),
      });

      lastOrderId = order.id;
      cart = [];
      deliveryChargeOverride = null;
      orderType = 'Dine-In';
      renderOrderTypeButtons();
      renderCustomerFields(false);
      renderCart();
      toaster.success(`Order #${order.id} submitted — ${money(order.total)}`);

      await printAndNotify(order.id, { silent: true });
    } catch (err) {
      toaster.error(err.message);
    } finally {
      submitBtn.disabled = cart.length === 0;
      submitBtn.textContent = 'Complete Order';
    }
  }

  function handleKeydown(event) {
    if (!document.body.contains(root)) return;
    if (event.key === 'Escape') {
      clearCart();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
      // Ctrl+P, not F5 - most 80/60-key laptop keyboards (very common
      // in Pakistan on Dell/HP/Lenovo models) wire F5 to a hardware
      // brightness/media function at the firmware level, so the key
      // event never reliably reaches the browser/Electron layer to
      // begin with. Ctrl+P is the universal "print" shortcut on every
      // desktop OS (including Ubuntu/GNOME apps) and isn't claimed by
      // any hardware function row.
      event.preventDefault();
      if (lastOrderId) printAndNotify(lastOrderId);
      else toaster.show('No recent order to reprint yet.', { duration: 2200 });
    }
  }
  document.addEventListener('keydown', handleKeydown);
  root._cleanup = () => document.removeEventListener('keydown', handleKeydown);

  (async () => {
    try {
      const [items, cats, settings] = await Promise.all([
        posApi.items.list({ onlyAvailable: false }),
        posApi.items.listCategories(),
        posApi.settings.getAll(),
      ]);
      menuItems = items;
      categories = applySavedCategoryOrder(cats, settings.menu_category_order);
      taxRate = Number(settings.default_tax_rate || 0);
      deliveryCharge = Number(settings.delivery_charge || 0);
      buildLayout();
    } catch (err) {
      toaster.error('Failed to load New Order: ' + err.message);
    }
  })();

  return root;
}
