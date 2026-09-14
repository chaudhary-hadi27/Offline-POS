'use strict';

import { posApi } from '../shell/posApi.js';
import { iconMarkup } from '../shell/icons.js';
import { attachRipple, attachRippleAll } from '../shell/ripple.js';
import { toaster } from '../shell/toast.js';
import { confirmAction } from '../shell/confirmDialog.js';
import { resizeImageToThumbnail } from './shared/imageResize.js';
import { hydrateItemImages, invalidateItemImage } from './shared/imageCache.js';
import { searchBarHtml, wireSearchBar } from '../shell/searchBar.js';

function money(n) {
  return `Rs. ${Number(n).toFixed(2)}`;
}

/** Fades an element's content out, swaps it, fades back in - avoids the instant "jerk" of a raw innerHTML replace. */
function smoothUpdate(el, renderFn) {
  el.style.transition = 'opacity 160ms ease';
  el.style.opacity = '0';
  setTimeout(() => {
    renderFn();
    requestAnimationFrame(() => {
      el.style.opacity = '1';
    });
  }, 160);
}

/** ON/OFF pill switch: green + knob right when on, red + knob left when off.
 *  Uses literal hex colors (not the "success"/"danger" theme tokens) so this
 *  never depends on Tailwind config wiring - it always renders correctly. */
function toggleClasses(isOn) {
  return {
    track: `toggle-btn ripple-host relative h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200 ease-in-out ${isOn ? 'bg-[#16A34A]' : 'bg-[#DC2626]'}`,
    knob: `absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ease-in-out ${isOn ? 'translate-x-[20px]' : 'translate-x-0'}`,
    text: `text-xs font-medium ${isOn ? 'text-[#16A34A]' : 'text-[#DC2626]'}`,
  };
}

const PLACEHOLDER_THUMB = `
  <span class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-surface-raised text-ink-muted">
    <span class="h-4 w-4">${iconMarkup('utensils')}</span>
  </span>`;

function itemThumb(item) {
  if (!item.image_path) return PLACEHOLDER_THUMB;
  return `<img data-image-path="${item.image_path}" alt="" class="h-11 w-11 flex-shrink-0 rounded-lg object-cover opacity-0 transition-opacity duration-200 bg-surface-raised" />`;
}

/** "3 options from Rs. 250" - shown on the item row when it has price variants. */
function priceVariantSummary(item) {
  const variants = item.priceVariants || [];
  if (variants.length === 0) return money(item.price);
  const min = Math.min(...variants.map((v) => v.price));
  return `${variants.length} options from ${money(min)}`;
}

export function renderMenuSetup() {
  const root = document.createElement('div');
  root.className = 'flex h-full w-full flex-col overflow-hidden bg-surface';

  let items = [];
  let categories = [];
  let activeCategory = 'All';
  let searchTerm = '';
  let editingItem = null; // null = create mode, object = edit mode
  let pendingImageDataUrl = null; // set when the admin picks a new photo in the panel
  let removeExistingImage = false;
  let variantRows = []; // [{id, label, price}] - working copy while the panel is open
  let nextVariantRowId = 1;

  root.innerHTML = `
    <header class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-8 py-5 md:px-12">
      <div>
        <h1 class="font-display text-xl font-bold text-ink">Menu Setup</h1>
        <p class="text-sm text-ink-secondary">Manage items, pricing, photos, and stock</p>
      </div>
      <div class="flex items-center gap-2">
        <div class="relative">
          <button type="button" id="auto-detect-images-btn"
            class="ripple-host flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-ink-secondary shadow-card transition-colors hover:border-accent/40 hover:text-ink">
            <span class="h-4 w-4">${iconMarkup('image')}</span> Auto-Detect Images
          </button>
          <span id="auto-detect-badge" class="pointer-events-none hidden absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold leading-none text-white"></span>
        </div>
        <input type="file" id="gallery-folder-input" webkitdirectory multiple accept="image/png,image/jpeg" class="hidden" />
        <button type="button" id="add-item-btn"
          class="ripple-host flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-card transition-colors hover:bg-accent-hover">
          <span class="h-4 w-4">+</span> Add Item
        </button>
      </div>
    </header>

    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-8 py-3 md:px-12">
      <div id="category-tabs" class="flex flex-wrap gap-2"></div>
      <div class="flex items-center gap-2">
        <button type="button" id="manage-categories-btn" title="Manage Categories"
          class="ripple-host flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/40 hover:text-ink">
          <span class="h-3.5 w-3.5">${iconMarkup('settings')}</span> Manage Categories
        </button>
        <div class="w-56">${searchBarHtml({ placeholder: 'Search items or SKU', id: 'menu-search' })}</div>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto px-8 py-6 md:px-12">
      <div id="items-table" class="overflow-hidden rounded-2xl border border-border transition-opacity duration-150"></div>
    </div>

    <!-- Slide-over panel: add / edit item -->
    <div id="item-panel-overlay" class="fixed inset-0 z-40 hidden">
      <div class="panel-scrim absolute inset-0 bg-black/60 backdrop-blur-md"></div>
      <div id="item-panel" class="panel-slide-in absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto bg-surface p-6 shadow-modal">
        <div class="mb-6 flex items-center justify-between">
          <h2 id="panel-title" class="font-display text-lg font-bold text-ink">Add Item</h2>
          <button type="button" id="panel-close" class="ripple-host flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink">
            <span class="h-4 w-4">${iconMarkup('close')}</span>
          </button>
        </div>
        <form id="item-form" class="flex flex-col gap-4">
          <div class="flex flex-col gap-1.5 text-sm">
            <span class="font-medium text-ink-secondary">Photo (optional)</span>
            <div class="flex items-center gap-3">
              <div id="image-preview" class="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-surface-raised text-ink-muted">
                <span class="h-6 w-6">${iconMarkup('utensils')}</span>
              </div>
              <div class="flex flex-col gap-1.5">
                <div class="flex gap-1.5">
                  <label class="ripple-host w-fit cursor-pointer rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">
                    Choose photo
                    <input type="file" id="image-input" accept="image/*" class="hidden" />
                  </label>
                  <button type="button" id="gallery-picker-btn"
                    class="ripple-host w-fit rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">
                    Choose from Gallery
                  </button>
                </div>
                <button type="button" id="remove-image-btn" class="hidden w-fit text-xs text-ink-muted hover:text-accent">Remove photo</button>
              </div>
            </div>
          </div>
          <label class="flex flex-col gap-1.5 text-sm">
            <span class="font-medium text-ink-secondary">Short code (SKU) <span class="font-normal text-ink-muted">- optional</span></span>
            <input name="sku" maxlength="20" placeholder="Auto-generated if left blank"
              class="rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
          </label>
          <label class="flex flex-col gap-1.5 text-sm">
            <span class="font-medium text-ink-secondary">Item name</span>
            <input name="name" required
              class="rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
          </label>
          <label class="flex flex-col gap-1.5 text-sm">
            <span class="font-medium text-ink-secondary">Urdu name <span class="font-normal text-ink-muted">- optional</span></span>
            <input name="nameUrdu" dir="rtl" maxlength="120" placeholder="مثلاً سپریم پیزا"
              class="rounded-xl border border-border px-3.5 py-2.5 text-right text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
          </label>
          <div class="flex flex-col gap-1.5 text-sm">
            <span class="font-medium text-ink-secondary">Category</span>
            <div class="flex items-center gap-2">
              <div class="relative flex-1">
                <button type="button" id="category-select-btn"
                  class="flex w-full items-center justify-between rounded-xl border border-border px-3.5 py-2.5 text-left text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20">
                  <span id="category-select-label" class="truncate text-ink-muted">Select a category</span>
                  <span class="h-4 w-4 flex-shrink-0 text-ink-muted">${iconMarkup('chevronDown')}</span>
                </button>
                <div id="category-dropdown" class="absolute z-20 mt-1.5 hidden w-full rounded-xl border border-border bg-surface p-2 shadow-modal">
                  <input type="text" id="category-filter-input" placeholder="Search categories..."
                    class="mb-2 w-full rounded-lg border border-border px-2.5 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
                  <div id="category-options" class="flex max-h-48 flex-col gap-0.5 overflow-y-auto"></div>
                </div>
              </div>
              <button type="button" id="category-add-toggle-btn" title="Add a new category"
                class="ripple-host flex h-[42px] w-[42px] flex-shrink-0 items-center justify-center rounded-xl border border-border text-ink-secondary hover:border-accent/30 hover:text-accent">
                <span class="h-4 w-4">${iconMarkup('plus')}</span>
              </button>
            </div>
            <div id="category-new-row" class="hidden flex-col gap-2">
              <input type="text" id="category-new-input" placeholder="Type new category name"
                class="w-full rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
              <div class="flex flex-wrap items-center gap-2">
                <button type="button" id="category-new-save-btn"
                  class="ripple-host flex-1 whitespace-nowrap rounded-xl bg-accent px-3.5 py-2.5 text-sm font-medium text-white hover:bg-accent-hover" style="min-width: 130px;">Add Category</button>
                <button type="button" id="category-new-cancel-btn"
                  class="ripple-host flex-1 whitespace-nowrap rounded-xl border border-border px-3.5 py-2.5 text-sm font-medium text-ink-secondary hover:bg-surface-raised" style="min-width: 90px;">Cancel</button>
              </div>
            </div>
            <input type="hidden" name="category" id="category-hidden-input" required />
          </div>
          <label class="flex flex-col gap-1.5 text-sm">
            <span class="font-medium text-ink-secondary">Price (Rs.)</span>
            <input name="price" type="number" min="0" step="0.01" required
              class="rounded-xl border border-border px-3.5 py-2.5 text-sm font-nums focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
          </label>
          <label class="flex flex-col gap-1.5 text-sm">
            <span class="font-medium text-ink-secondary">Description <span class="font-normal text-ink-muted">- optional</span></span>
            <textarea name="description" rows="3" maxlength="400" placeholder="Ingredients, spice level, portion size... shown only in the New Order item popup"
              class="resize-none rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"></textarea>
          </label>

          <div class="flex flex-col gap-2 text-sm">
            <div class="flex items-center justify-between">
              <span class="font-medium text-ink-secondary">Price options <span class="font-normal text-ink-muted">- optional</span></span>
              <button type="button" id="add-variant-btn" class="ripple-host rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10">+ Add option</button>
            </div>
            <div id="variant-rows" class="flex flex-col gap-2"></div>
          </div>

          <div class="mt-2 flex gap-3">
            <button type="submit"
              class="ripple-host flex-1 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover">
              Save
            </button>
            <button type="button" id="panel-cancel"
              class="ripple-host rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-ink-secondary hover:bg-surface-raised">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  const addBtn = root.querySelector('#add-item-btn');
  const autoDetectBtn = root.querySelector('#auto-detect-images-btn');
  const galleryFolderInput = root.querySelector('#gallery-folder-input');
  const tabsEl = root.querySelector('#category-tabs');
  const manageCategoriesBtn = root.querySelector('#manage-categories-btn');
  const tableEl = root.querySelector('#items-table');
  const panelOverlay = root.querySelector('#item-panel-overlay');
  const panel = root.querySelector('#item-panel');
  const panelTitle = root.querySelector('#panel-title');
  const panelForm = root.querySelector('#item-form');
  const panelScrim = root.querySelector('.panel-scrim');
  const categoryHiddenInput = root.querySelector('#category-hidden-input');
  const categorySelectBtn = root.querySelector('#category-select-btn');
  const categorySelectLabel = root.querySelector('#category-select-label');
  const categoryDropdown = root.querySelector('#category-dropdown');
  const categoryFilterInput = root.querySelector('#category-filter-input');
  const categoryOptionsEl = root.querySelector('#category-options');
  const categoryAddToggleBtn = root.querySelector('#category-add-toggle-btn');
  const categoryNewRow = root.querySelector('#category-new-row');
  const categoryNewInput = root.querySelector('#category-new-input');
  const categoryNewSaveBtn = root.querySelector('#category-new-save-btn');
  const categoryNewCancelBtn = root.querySelector('#category-new-cancel-btn');
  const imagePreview = root.querySelector('#image-preview');
  const imageInput = root.querySelector('#image-input');
  const galleryPickerBtn = root.querySelector('#gallery-picker-btn');
  const removeImageBtn = root.querySelector('#remove-image-btn');
  const variantRowsHost = root.querySelector('#variant-rows');
  const addVariantBtn = root.querySelector('#add-variant-btn');

  // CRITICAL: only NOW move the whole panel overlay out of `root` and
  // onto <body> directly - after every element inside it has already
  // been queried above (root.querySelector needs the overlay to still
  // be a descendant of root to find any of that). `root` lives inside
  // the router's `.route-layer`, which always carries
  // `will-change: transform` (and `transform: translateX(0)` once
  // active) for the page-slide effect - see src/styles/main.css. A CSS
  // transform on an ancestor creates a new containing block for any
  // `position: fixed` descendant, so as originally written this
  // overlay wasn't actually fixed to the real window - it was
  // silently constrained to the content stage's box instead (missing
  // the sidebar entirely, i.e. "feeling out of container"), and any
  // recalculation of that transform mid-animation visibly jerked the
  // scrim/panel's position. Moving it to a true body-level sibling
  // (exactly how the popups in newOrder.js already do it) makes it a
  // real fixed-to-viewport overlay with nothing above it to jerk.
  document.body.appendChild(panelOverlay);

  attachRipple(addBtn);
  attachRipple(autoDetectBtn);
  attachRipple(manageCategoriesBtn);
  attachRipple(addVariantBtn);
  attachRipple(categoryAddToggleBtn);
  attachRipple(galleryPickerBtn);
  attachRipple(categoryNewSaveBtn);
  attachRipple(categoryNewCancelBtn);

  // ---------------- Category picker: searchable dropdown + "+" add-new ----------------
  // The value of record always lives in the hidden #category-hidden-input,
  // which shares the form's "category" name - so panelForm.category.value
  // and FormData both keep working exactly as before. Everything below
  // just keeps the visible button/label in sync with that hidden input.
  function setCategoryValue(value) {
    categoryHiddenInput.value = value || '';
    categorySelectLabel.textContent = value || 'Select a category';
    categorySelectLabel.classList.toggle('text-ink-muted', !value);
    categorySelectLabel.classList.toggle('text-ink', !!value);
  }

  function renderCategoryOptions(filterText = '') {
    const term = filterText.trim().toLowerCase();
    const matches = categories.filter((c) => c.toLowerCase().includes(term));
    if (matches.length === 0) {
      categoryOptionsEl.innerHTML = `<p class="px-2.5 py-3 text-center text-xs text-ink-muted">${
        categories.length === 0 ? 'No categories yet - use the + button to add one.' : 'No matching categories.'
      }</p>`;
      return;
    }
    categoryOptionsEl.innerHTML = matches
      .map(
        (c) => `
      <button type="button" data-category-option="${c}"
        class="flex items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-accent/10 hover:text-accent">
        <span class="truncate">${c}</span>
        ${c === categoryHiddenInput.value ? `<span class="h-3.5 w-3.5 flex-shrink-0 text-accent">${iconMarkup('check')}</span>` : ''}
      </button>`
      )
      .join('');
    categoryOptionsEl.querySelectorAll('[data-category-option]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setCategoryValue(btn.dataset.categoryOption);
        closeCategoryDropdown();
      });
    });
  }

  function openCategoryDropdown() {
    categoryDropdown.classList.remove('hidden');
    categoryFilterInput.value = '';
    renderCategoryOptions('');
    categoryFilterInput.focus();
  }
  function closeCategoryDropdown() {
    categoryDropdown.classList.add('hidden');
  }

  categorySelectBtn.addEventListener('click', () => {
    const isOpen = !categoryDropdown.classList.contains('hidden');
    isOpen ? closeCategoryDropdown() : openCategoryDropdown();
  });
  categoryFilterInput.addEventListener('input', () => renderCategoryOptions(categoryFilterInput.value));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#category-select-btn') && !e.target.closest('#category-dropdown')) {
      closeCategoryDropdown();
    }
  });

  function openNewCategoryRow() {
    closeCategoryDropdown();
    categoryNewRow.classList.remove('hidden');
    categoryNewRow.classList.add('flex');
    categoryNewInput.value = '';
    categoryNewInput.focus();
    // Guarantee the Add/Cancel buttons are actually on-screen the
    // instant this opens, regardless of where the panel happened to
    // be scrolled to - "focus()" alone only scrolls the input into
    // view, not necessarily the buttons below it.
    categoryNewRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function closeNewCategoryRow() {
    categoryNewRow.classList.add('hidden');
    categoryNewRow.classList.remove('flex');
  }
  function commitNewCategory() {
    const name = categoryNewInput.value.trim();
    if (!name) {
      closeNewCategoryRow();
      return;
    }
    if (!categories.includes(name)) categories = [...categories, name].sort((a, b) => a.localeCompare(b));
    setCategoryValue(name);
    closeNewCategoryRow();
  }

  categoryAddToggleBtn.addEventListener('click', openNewCategoryRow);
  categoryNewCancelBtn.addEventListener('click', closeNewCategoryRow);
  categoryNewSaveBtn.addEventListener('click', commitNewCategory);
  categoryNewInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitNewCategory();
    } else if (e.key === 'Escape') {
      closeNewCategoryRow();
    }
  });

  wireSearchBar(root, (value) => {
    searchTerm = value;
    smoothUpdate(tableEl, renderTable);
  });

  function setPreview(dataUrlOrNull) {
    if (dataUrlOrNull) {
      imagePreview.innerHTML = `<img src="${dataUrlOrNull}" alt="" class="h-full w-full object-cover" />`;
      removeImageBtn.classList.remove('hidden');
    } else {
      imagePreview.innerHTML = `<span class="h-6 w-6">${iconMarkup('utensils')}</span>`;
      removeImageBtn.classList.add('hidden');
    }
  }

  imageInput.addEventListener('change', async () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    try {
      pendingImageDataUrl = await resizeImageToThumbnail(file);
      removeExistingImage = false;
      setPreview(pendingImageDataUrl);
    } catch (err) {
      toaster.error(err.message);
    } finally {
      imageInput.value = '';
    }
  });

  galleryPickerBtn.addEventListener('click', () => openGalleryPicker());

  /**
   * "Choose from Gallery" - the single place to browse AND manage
   * item photos. Merges two sources into one categorized view:
   *   - the bundled, read-only electron/database/seed-images/<Category>/
   *     folders (see electron/database/seedGallery.js)
   *   - the admin's own saved photos (electron/images/customGallery.js),
   *     writable, which is also where "New category" and "Upload photo"
   *     below actually save to (seed-images/ ships inside the installer
   *     and can't be written to at runtime).
   * A photo added here immediately becomes an Auto-Detect candidate too
   * - see candidatesFromGallery() - so there's no separate "Manage
   * Gallery" step to remember. Picking any thumbnail goes through the
   * exact same resizeImageToThumbnail() compression step a manual
   * upload does, so from here down it's indistinguishable from "Choose
   * photo".
   */
  /** "grilled_chicken-v2.jpg" -> "Grilled Chicken V2" - strips the
   *  extension (meaningless to a cashier picking a photo) and turns
   *  filename separators into a readable, title-cased label. */
  function humanizeFilename(filename) {
    const base = String(filename).replace(/\.[a-zA-Z0-9]+$/, '');
    return base
      .replace(/[_-]+/g, ' ')
      .trim()
      .split(/\s+/)
      .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
      .join(' ');
  }

  /**
   * "Choose from Gallery" - a full-screen browser for every photo
   * available to this app: the bundled, read-only
   * electron/database/seed-images/<Category>/ folders (see
   * electron/database/seedGallery.js) merged with the admin's own
   * saved photos (electron/images/customGallery.js, writable - also
   * where "Add Photo" below actually saves to, since seed-images/
   * ships inside the installer and can't be written to at runtime).
   *
   * Full-screen (not a small centered card) and a flat, searchable,
   * lazily-loaded grid on purpose - this is the same interaction
   * shape production photo pickers use (Google Photos, a DAM asset
   * picker, etc): picking a photo is the overwhelmingly common
   * action, so it gets the whole screen and a single click; adding
   * and managing photos are rarer, so they're tucked behind their own
   * toggles instead of competing for attention on every thumbnail.
   *
   *   - Picking:  click any photo. Always available, in both modes.
   *   - Adding:   "Add Photo" opens a drag-and-drop drawer.
   *   - Managing: the "Manage" toggle reveals a "..." button on the
   *     admin's own photos (rename / move category / delete) and on
   *     categories that contain at least one of them (rename / delete
   *     the category). Bundled seed photos/categories never show this
   *     - there's nothing there that can actually be changed.
   *
   * Thumbnails load lazily via IntersectionObserver as they scroll
   * into view (a skeleton shimmer placeholder until then), so a large
   * combined gallery never pays to fetch photos the admin never
   * scrolls to.
   */
  async function openGalleryPicker() {
    const currentCategory = categoryHiddenInput.value;

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-40 flex flex-col bg-surface';
    overlay.innerHTML = `
      <div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 sm:px-6">
        <button type="button" id="gallery-close" title="Close"
          class="ripple-host flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink">
          <span class="h-5 w-5">${iconMarkup('chevronLeft')}</span>
        </button>
        <h2 class="font-display text-base font-bold text-ink">Choose from Gallery</h2>

        <div class="ml-auto flex flex-1 items-center justify-end gap-2 sm:flex-none">
          <div class="relative w-full max-w-[220px] sm:w-56">
            <span class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted">${iconMarkup('search')}</span>
            <input type="text" id="gallery-search" placeholder="Search photos..."
              class="w-full rounded-lg border border-border bg-surface py-1.5 pl-8 pr-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
          </div>
          <button type="button" id="gallery-manage-toggle"
            class="ripple-host flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/40 hover:text-ink">
            <span class="h-3.5 w-3.5">${iconMarkup('edit')}</span> Manage
          </button>
          <button type="button" id="gallery-add-toggle"
            class="ripple-host flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover">
            <span class="h-3.5 w-3.5">${iconMarkup('plus')}</span> Add Photo
          </button>
        </div>
      </div>

      <div id="gallery-upload-drawer" class="hidden border-b border-border bg-surface-raised px-4 py-4 sm:px-6">
        <div class="mx-auto flex max-w-xl flex-col gap-3">
          <div id="gallery-dropzone"
            class="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-border px-4 py-6 text-center transition-colors hover:border-accent/50 hover:bg-surface">
            <span class="h-6 w-6 text-ink-muted">${iconMarkup('image')}</span>
            <p class="text-sm font-medium text-ink">Drop a photo here, or click to browse</p>
            <p class="text-xs text-ink-muted">PNG, JPG or WEBP</p>
            <input type="file" id="gallery-add-file" accept="image/png,image/jpeg,image/webp" class="hidden" />
          </div>
          <div id="gallery-add-details" class="hidden flex-col gap-2 rounded-xl border border-border bg-surface p-3">
            <div class="flex items-center gap-2">
              <div id="gallery-add-thumb" class="h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg border border-border bg-surface-raised"></div>
              <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                <input type="text" id="gallery-add-name" placeholder="Name (e.g. Crown Crust)" maxlength="80"
                  class="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
                <div class="flex items-center gap-2">
                  <select id="gallery-add-category-select"
                    class="flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20">
                    <option value="">Loading categories...</option>
                  </select>
                  <button type="button" id="gallery-add-save" disabled
                    class="ripple-host rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
                    Save
                  </button>
                </div>
                <input type="text" id="gallery-add-category-new" placeholder="Type new category name" maxlength="60"
                  class="hidden rounded-lg border border-border bg-surface px-3 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div id="gallery-chips" class="flex items-center gap-2 overflow-x-auto border-b border-border px-4 py-2.5 sm:px-6"></div>

      <div id="gallery-body" class="flex-1 overflow-y-auto px-4 py-4 sm:px-6"></div>
    `;
    document.body.appendChild(overlay);

    function close() {
      thumbObserver.disconnect();
      overlay.remove();
    }
    overlay.querySelector('#gallery-close').addEventListener('click', close);
    attachRipple(overlay.querySelector('#gallery-close'));
    // No backdrop to click through - full-screen has nothing behind it.
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', escHandler);
        close();
      }
    };
    document.addEventListener('keydown', escHandler);

    const chipsEl = overlay.querySelector('#gallery-chips');
    const bodyEl = overlay.querySelector('#gallery-body');
    const searchInput = overlay.querySelector('#gallery-search');
    const manageToggleBtn = overlay.querySelector('#gallery-manage-toggle');
    const addToggleBtn = overlay.querySelector('#gallery-add-toggle');
    const uploadDrawer = overlay.querySelector('#gallery-upload-drawer');
    attachRipple(manageToggleBtn);
    attachRipple(addToggleBtn);

    let mergedCategories = []; // [{category, images: [{filename, source, label}]}]
    let manageMode = false;
    let selectedCategory = null; // null = "All"
    let searchQuery = '';
    let hasAppliedInitialCategory = false;

    const thumbObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          thumbObserver.unobserve(entry.target);
          loadThumbnail(entry.target);
        });
      },
      { root: bodyEl, rootMargin: '300px' }
    );

    function filteredImages() {
      const q = searchQuery.trim().toLowerCase();
      const out = [];
      mergedCategories.forEach((c) => {
        if (selectedCategory && c.category !== selectedCategory) return;
        c.images.forEach((img) => {
          if (q && !img.label.toLowerCase().includes(q)) return;
          out.push({ ...img, category: c.category });
        });
      });
      return out;
    }

    function renderChips() {
      const all = [{ category: null, label: 'All', count: mergedCategories.reduce((n, c) => n + c.images.length, 0) }].concat(
        mergedCategories.map((c) => ({ category: c.category, label: c.category, count: c.images.length, hasCustom: c.images.some((i) => i.source === 'custom') }))
      );
      chipsEl.innerHTML = all
        .map((chip) => {
          const isActive = selectedCategory === chip.category;
          return `
          <div class="flex flex-shrink-0 items-center">
            <button type="button" data-chip="${chip.category === null ? '' : escapeAttr(chip.category)}"
              class="ripple-host whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive ? 'border-accent bg-accent text-white' : 'border-border text-ink-secondary hover:border-accent/40 hover:text-ink'
              }">
              ${escapeAttr(chip.label)} <span class="${isActive ? 'text-white/80' : 'text-ink-muted'}">${chip.count}</span>
            </button>
            ${manageMode && chip.category !== null && chip.hasCustom ? `
            <button type="button" data-chip-menu="${escapeAttr(chip.category)}" title="Category options"
              class="ripple-host -ml-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-surface-raised hover:text-ink">
              <span class="h-3.5 w-3.5">${iconMarkup('moreVertical')}</span>
            </button>` : ''}
          </div>`;
        })
        .join('');

      chipsEl.querySelectorAll('[data-chip]').forEach((btn) => {
        attachRipple(btn);
        btn.addEventListener('click', () => {
          selectedCategory = btn.dataset.chip || null;
          renderChips();
          renderGrid();
        });
      });
      chipsEl.querySelectorAll('[data-chip-menu]').forEach((btn) => {
        attachRipple(btn);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openCategoryOptionsModal(btn.dataset.chipMenu);
        });
      });
    }

    function renderGrid() {
      thumbObserver.disconnect();
      const images = filteredImages();

      if (mergedCategories.length === 0) {
        bodyEl.innerHTML = `
          <div class="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span class="h-8 w-8 text-ink-muted">${iconMarkup('image')}</span>
            <p class="text-sm font-medium text-ink">No gallery photos yet - tap "Add Photo" above</p>
          </div>`;
        return;
      }
      if (images.length === 0) {
        bodyEl.innerHTML = `
          <div class="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span class="h-8 w-8 text-ink-muted">${iconMarkup('search')}</span>
            <p class="text-sm font-medium text-ink">No photos match "${escapeAttr(searchQuery)}"</p>
          </div>`;
        return;
      }

      bodyEl.innerHTML = `
        <div class="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
          ${images
            .map(
              (img) => `
            <div class="group relative">
              <button type="button" data-pick-image data-category="${escapeAttr(img.category)}" data-filename="${escapeAttr(img.filename)}" data-source="${img.source}" title="${escapeAttr(img.label)}"
                class="ripple-host flex w-full flex-col overflow-hidden rounded-lg border border-border bg-surface-raised text-ink-muted transition-colors hover:border-accent/50">
                <span data-thumb class="flex aspect-square w-full items-center justify-center overflow-hidden bg-surface-raised">
                  <span class="h-full w-full animate-pulse bg-border/60"></span>
                </span>
                <span class="truncate border-t border-border px-1.5 py-1 text-[11px] leading-tight text-ink-secondary">${escapeAttr(img.label)}</span>
              </button>
              ${manageMode && img.source === 'custom' ? `
              <button type="button" data-photo-menu-category="${escapeAttr(img.category)}" data-photo-menu-filename="${escapeAttr(img.filename)}" title="Edit photo"
                class="gallery-photo-menu-btn ripple-host absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/75">
                <span class="h-3.5 w-3.5">${iconMarkup('moreVertical')}</span>
              </button>` : ''}
              ${manageMode && img.source === 'seed' ? `
              <span class="pointer-events-none absolute left-1 top-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[9px] font-medium text-white">Built-in</span>
              ` : ''}
            </div>`
            )
            .join('')}
        </div>
      `;

      bodyEl.querySelectorAll('[data-pick-image]').forEach((btn) => {
        thumbObserver.observe(btn.querySelector('[data-thumb]'));
        btn.addEventListener('click', async () => {
          const category = btn.dataset.category;
          const filename = btn.dataset.filename;
          const source = btn.dataset.source;
          try {
            const dataUrl = source === 'seed' ? await posApi.seedGallery.getImage(category, filename) : await posApi.customGallery.getImage(filename);
            if (!dataUrl) return;
            // Seed photos aren't pre-resized, so they go through the
            // same pipeline a manual upload gets; custom gallery
            // entries are already a saved thumbnail.
            pendingImageDataUrl = source === 'seed' ? await resizeDataUrlToThumbnail(dataUrl) : dataUrl;
            removeExistingImage = false;
            setPreview(pendingImageDataUrl);
            close();
          } catch (err) {
            toaster.error(err.message);
          }
        });
      });

      bodyEl.querySelectorAll('.gallery-photo-menu-btn').forEach((btn) => {
        attachRipple(btn);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const cat = btn.dataset.photoMenuCategory;
          const filename = btn.dataset.photoMenuFilename;
          const section = mergedCategories.find((c) => c.category === cat);
          const img = section && section.images.find((i) => i.filename === filename && i.source === 'custom');
          if (img) openEditPhotoModal(cat, img);
        });
      });
    }

    /** Fetches a thumbnail's actual image bytes only once it scrolls
     *  into view (see thumbObserver above) - the skeleton shimmer
     *  placeholder sits there until then, so a large combined gallery
     *  never pays to fetch photos the admin never scrolls to. */
    async function loadThumbnail(thumbEl) {
      const btn = thumbEl.closest('[data-pick-image]');
      if (!btn || !btn.isConnected) return;
      const category = btn.dataset.category;
      const filename = btn.dataset.filename;
      const source = btn.dataset.source;
      try {
        const dataUrl = source === 'seed' ? await posApi.seedGallery.getImage(category, filename) : await posApi.customGallery.getImage(filename);
        if (!dataUrl || !thumbEl.isConnected) return;
        thumbEl.innerHTML = `<img src="${dataUrl}" alt="" class="h-full w-full object-cover" />`;
      } catch {
        if (thumbEl.isConnected) thumbEl.innerHTML = `<span class="h-3.5 w-3.5">${iconMarkup('close')}</span>`;
      }
    }

    /** Reloads both sources and re-merges them by category name, so a
     *  photo added under an existing seed category (e.g. "Pizzas")
     *  shows up grouped with the bundled ones instead of splitting
     *  into a second entry. */
    async function loadMerged() {
      let seedCats = [];
      try {
        seedCats = await posApi.seedGallery.list();
      } catch (err) {
        toaster.error(`Could not load the photo gallery: ${err.message}`);
      }
      let customEntries = [];
      try {
        customEntries = await posApi.customGallery.list();
      } catch {
        customEntries = [];
      }

      const byCategory = new Map();
      seedCats.forEach((c) => {
        byCategory.set(c.category, {
          category: c.category,
          images: c.images.map((filename) => ({ filename, source: 'seed', label: humanizeFilename(filename) })),
        });
      });
      customEntries.forEach((entry) => {
        const cat = entry.category || 'Uncategorized';
        if (!byCategory.has(cat)) byCategory.set(cat, { category: cat, images: [] });
        byCategory.get(cat).images.push({ filename: entry.filename, source: 'custom', label: entry.name });
      });

      mergedCategories = [...byCategory.values()].filter((c) => c.images.length > 0).sort((a, b) => a.category.localeCompare(b.category));
      if (!hasAppliedInitialCategory) {
        // Pre-filter to the item's own category on first open, same as
        // the old accordion's "pre-expanded" behavior - zero clicks to
        // reach the relevant photos.
        hasAppliedInitialCategory = true;
        if (mergedCategories.some((c) => c.category === currentCategory)) selectedCategory = currentCategory;
      } else if (selectedCategory && !mergedCategories.some((c) => c.category === selectedCategory)) {
        selectedCategory = null;
      }

      fillUploadCategorySelect(mergedCategories.map((c) => c.category));
      renderChips();
      renderGrid();
    }

    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      renderGrid();
    });

    manageToggleBtn.addEventListener('click', () => {
      manageMode = !manageMode;
      manageToggleBtn.classList.toggle('border-accent', manageMode);
      manageToggleBtn.classList.toggle('text-accent', manageMode);
      renderChips();
      renderGrid();
    });

    // --- "Add Photo" drawer: drag-and-drop + a compact inline form ---
    const dropzone = overlay.querySelector('#gallery-dropzone');
    const fileInput = overlay.querySelector('#gallery-add-file');
    const detailsPanel = overlay.querySelector('#gallery-add-details');
    const addThumb = overlay.querySelector('#gallery-add-thumb');
    const nameInput = overlay.querySelector('#gallery-add-name');
    const categorySelect = overlay.querySelector('#gallery-add-category-select');
    const categoryNewInput = overlay.querySelector('#gallery-add-category-new');
    const saveBtn = overlay.querySelector('#gallery-add-save');
    attachRipple(saveBtn);

    const NEW_CATEGORY_VALUE = '__new__';
    let pendingFile = null;
    let pendingFileDataUrl = null;

    addToggleBtn.addEventListener('click', () => {
      uploadDrawer.classList.toggle('hidden');
    });

    function fillUploadCategorySelect(categoryNames) {
      categorySelect.innerHTML =
        (categoryNames.length
          ? categoryNames.map((c) => `<option value="${escapeAttr(c)}">${c}</option>`).join('')
          : `<option value="" disabled selected>No categories yet</option>`) +
        `<option value="${NEW_CATEGORY_VALUE}">+ New category...</option>`;
      if (categoryNames.includes(currentCategory)) categorySelect.value = currentCategory;
      else if (categoryNames.length) categorySelect.value = categoryNames[0];
    }
    function selectedUploadCategoryName() {
      if (categorySelect.value === NEW_CATEGORY_VALUE) return categoryNewInput.value.trim();
      return categorySelect.value.trim();
    }
    function updateSaveEnabled() {
      saveBtn.disabled = !pendingFile || !nameInput.value.trim() || !selectedUploadCategoryName();
    }
    nameInput.addEventListener('input', updateSaveEnabled);
    categoryNewInput.addEventListener('input', updateSaveEnabled);
    categorySelect.addEventListener('change', () => {
      const isNew = categorySelect.value === NEW_CATEGORY_VALUE;
      categoryNewInput.classList.toggle('hidden', !isNew);
      if (isNew) categoryNewInput.focus();
      updateSaveEnabled();
    });

    async function handlePickedFile(file) {
      if (!file || !/^image\//.test(file.type)) {
        toaster.error('Please choose a PNG, JPG or WEBP photo.');
        return;
      }
      pendingFile = file;
      try {
        pendingFileDataUrl = await resizeImageToThumbnail(file);
      } catch (err) {
        toaster.error(err.message);
        pendingFile = null;
        return;
      }
      addThumb.innerHTML = `<img src="${pendingFileDataUrl}" alt="" class="h-full w-full object-cover" />`;
      if (!nameInput.value.trim()) nameInput.value = humanizeFilename(file.name);
      detailsPanel.classList.remove('hidden');
      detailsPanel.classList.add('flex');
      updateSaveEnabled();
    }

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('border-accent/60', 'bg-surface');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('border-accent/60', 'bg-surface');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('border-accent/60', 'bg-surface');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handlePickedFile(file);
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) handlePickedFile(file);
    });

    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const category = selectedUploadCategoryName();
      if (!name || !pendingFileDataUrl || !category) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        await posApi.customGallery.add(name, category, pendingFileDataUrl);
        toaster.success(`"${name}" saved to the gallery.`);
        nameInput.value = '';
        categoryNewInput.value = '';
        categoryNewInput.classList.add('hidden');
        pendingFile = null;
        pendingFileDataUrl = null;
        fileInput.value = '';
        detailsPanel.classList.add('hidden');
        detailsPanel.classList.remove('flex');
        addThumb.innerHTML = '';
        uploadDrawer.classList.add('hidden');
        selectedCategory = category;
        await loadMerged();
        updateAutoDetectBadge();
      } catch (err) {
        toaster.error(err.message);
      } finally {
        saveBtn.textContent = 'Save';
        updateSaveEnabled();
      }
    });

    // --- "Edit Photo" - rename / move category / delete a single saved photo ---
    /** Small centered modal (stacked above the full-screen picker) to
     *  rename a saved photo, move it to a different category, or
     *  remove it. Reuses customGallery.add()'s "same slug replaces"
     *  behavior: renaming saves under the new name then deletes the
     *  old file/entry only if the slug actually changed (a category-
     *  only change keeps the same filename, so nothing extra to clean
     *  up). */
    function openEditPhotoModal(category, img) {
      const sub = document.createElement('div');
      sub.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
      sub.innerHTML = `
        <div class="edit-scrim scrim-enter absolute inset-0 bg-black/60 backdrop-blur-sm"></div>
        <div class="modal-pop relative flex w-full max-w-sm flex-col rounded-2xl border border-border bg-surface shadow-modal">
          <div class="flex items-center justify-between border-b border-border px-5 py-4">
            <h3 class="font-display text-base font-bold text-ink">Edit Photo</h3>
            <button type="button" id="edit-photo-close" title="Close"
              class="ripple-host flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink">
              <span class="h-4 w-4">${iconMarkup('close')}</span>
            </button>
          </div>
          <div class="flex flex-col gap-2 p-4">
            <label class="flex flex-col gap-1 text-xs font-medium text-ink-secondary">
              Name
              <input type="text" id="edit-photo-name" maxlength="80" value="${escapeAttr(img.label)}"
                class="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
            </label>
            <label class="flex flex-col gap-1 text-xs font-medium text-ink-secondary">
              Category
              <select id="edit-photo-category-select"
                class="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"></select>
            </label>
            <input type="text" id="edit-photo-category-new" placeholder="Type new category name" maxlength="60"
              class="hidden rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
            <div class="mt-2 flex items-center gap-2">
              <button type="button" id="edit-photo-remove"
                class="ripple-host flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-[#DC2626] hover:bg-[#DC2626]/10">
                <span class="h-3.5 w-3.5">${iconMarkup('trash')}</span> Remove
              </button>
              <button type="button" id="edit-photo-save"
                class="ripple-host ml-auto rounded-lg bg-accent px-4 py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
                Save
              </button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(sub);

      function closeSub() {
        sub.remove();
      }
      sub.querySelector('.edit-scrim').addEventListener('click', closeSub);
      sub.querySelector('#edit-photo-close').addEventListener('click', closeSub);
      attachRipple(sub.querySelector('#edit-photo-close'));

      const nameEl = sub.querySelector('#edit-photo-name');
      const catSelect = sub.querySelector('#edit-photo-category-select');
      const catNewInput = sub.querySelector('#edit-photo-category-new');
      const removeBtn = sub.querySelector('#edit-photo-remove');
      const saveBtnSub = sub.querySelector('#edit-photo-save');
      attachRipple(removeBtn);
      attachRipple(saveBtnSub);

      const NEW_CAT = '__new__';
      const categoryNames = mergedCategories.map((c) => c.category);
      catSelect.innerHTML =
        categoryNames.map((c) => `<option value="${escapeAttr(c)}">${c}</option>`).join('') + `<option value="${NEW_CAT}">+ New category...</option>`;
      catSelect.value = category;
      catSelect.addEventListener('change', () => {
        const isNew = catSelect.value === NEW_CAT;
        catNewInput.classList.toggle('hidden', !isNew);
        if (isNew) catNewInput.focus();
      });

      function chosenCategory() {
        return catSelect.value === NEW_CAT ? catNewInput.value.trim() : catSelect.value.trim();
      }

      removeBtn.addEventListener('click', async () => {
        if (!window.confirm(`Remove "${img.label}" from the gallery? This won't affect any item already using it.`)) return;
        try {
          await posApi.customGallery.remove(img.filename);
          closeSub();
          await loadMerged();
          updateAutoDetectBadge();
        } catch (err) {
          toaster.error(err.message);
        }
      });

      saveBtnSub.addEventListener('click', async () => {
        const newName = nameEl.value.trim();
        const newCategory = chosenCategory();
        if (!newName || !newCategory) return;
        saveBtnSub.disabled = true;
        try {
          const dataUrl = await posApi.customGallery.getImage(img.filename);
          const saved = await posApi.customGallery.add(newName, newCategory, dataUrl);
          // A name change means a new filename/slug - the old file is
          // otherwise left behind as an orphaned duplicate entry.
          if (saved.filename !== img.filename) await posApi.customGallery.remove(img.filename);
          toaster.success('Photo updated.');
          closeSub();
          selectedCategory = newCategory;
          await loadMerged();
          updateAutoDetectBadge();
        } catch (err) {
          toaster.error(err.message);
          saveBtnSub.disabled = false;
        }
      });
    }

    // --- "Category Options" - rename or delete an entire category ---
    /** Small centered modal to rename or delete an entire category -
     *  only offered for a category that has at least one of the
     *  admin's own saved photos in it (a purely bundled seed category
     *  has nothing here that can actually be changed). Renaming/
     *  deleting only ever touches the admin's own photos in that
     *  category; any bundled seed photos sharing the same category
     *  name are untouched either way. */
    function openCategoryOptionsModal(category) {
      const section = mergedCategories.find((c) => c.category === category);
      const customImages = section ? section.images.filter((i) => i.source === 'custom') : [];

      const sub = document.createElement('div');
      sub.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
      sub.innerHTML = `
        <div class="edit-scrim scrim-enter absolute inset-0 bg-black/60 backdrop-blur-sm"></div>
        <div class="modal-pop relative flex w-full max-w-sm flex-col rounded-2xl border border-border bg-surface shadow-modal">
          <div class="flex items-center justify-between border-b border-border px-5 py-4">
            <h3 class="font-display text-base font-bold text-ink">Category Options</h3>
            <button type="button" id="cat-opts-close" title="Close"
              class="ripple-host flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink">
              <span class="h-4 w-4">${iconMarkup('close')}</span>
            </button>
          </div>
          <div class="flex flex-col gap-3 p-4">
            <label class="flex flex-col gap-1 text-xs font-medium text-ink-secondary">
              Rename category
              <div class="flex items-center gap-2">
                <input type="text" id="cat-opts-rename" maxlength="60" value="${escapeAttr(category)}"
                  class="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
                <button type="button" id="cat-opts-rename-save"
                  class="ripple-host rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
                  Save
                </button>
              </div>
            </label>
            <p class="text-[11px] text-ink-muted">Renames this category on ${customImages.length} saved photo${customImages.length === 1 ? '' : 's'}. Bundled gallery photos in "${escapeAttr(category)}" (if any) keep their own name.</p>
            <button type="button" id="cat-opts-delete"
              class="ripple-host flex items-center justify-center gap-1.5 rounded-lg border border-[#DC2626]/30 px-3 py-2 text-xs font-medium text-[#DC2626] hover:bg-[#DC2626]/10">
              <span class="h-3.5 w-3.5">${iconMarkup('trash')}</span> Delete category (${customImages.length} photo${customImages.length === 1 ? '' : 's'})
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(sub);

      function closeSub() {
        sub.remove();
      }
      sub.querySelector('.edit-scrim').addEventListener('click', closeSub);
      sub.querySelector('#cat-opts-close').addEventListener('click', closeSub);
      attachRipple(sub.querySelector('#cat-opts-close'));

      const renameInput = sub.querySelector('#cat-opts-rename');
      const renameSaveBtn = sub.querySelector('#cat-opts-rename-save');
      const deleteBtn = sub.querySelector('#cat-opts-delete');
      attachRipple(renameSaveBtn);
      attachRipple(deleteBtn);

      renameSaveBtn.addEventListener('click', async () => {
        const newName = renameInput.value.trim();
        if (!newName || newName === category) return;
        renameSaveBtn.disabled = true;
        renameSaveBtn.textContent = 'Saving...';
        try {
          for (const img of customImages) {
            const dataUrl = await posApi.customGallery.getImage(img.filename);
            await posApi.customGallery.add(img.label, newName, dataUrl);
          }
          toaster.success(`Category renamed to "${newName}".`);
          closeSub();
          selectedCategory = newName;
          await loadMerged();
          updateAutoDetectBadge();
        } catch (err) {
          toaster.error(err.message);
          renameSaveBtn.disabled = false;
          renameSaveBtn.textContent = 'Save';
        }
      });

      deleteBtn.addEventListener('click', async () => {
        if (customImages.length === 0) {
          closeSub();
          return;
        }
        if (!window.confirm(`Delete ${customImages.length} saved photo${customImages.length === 1 ? '' : 's'} in "${category}"? This won't affect any item already using them.`)) return;
        deleteBtn.disabled = true;
        try {
          for (const img of customImages) {
            await posApi.customGallery.remove(img.filename);
          }
          toaster.success('Category photos removed.');
          closeSub();
          await loadMerged();
          updateAutoDetectBadge();
        } catch (err) {
          toaster.error(err.message);
          deleteBtn.disabled = false;
        }
      });
    }

    await loadMerged();
  }

  /** Runs an already-fetched gallery photo through the same square-crop
   *  + compress pipeline a manual upload gets, so every item photo -
   *  gallery or uploaded - ends up the same small, consistent size. */
  async function resizeDataUrlToThumbnail(dataUrl) {
    const blob = await fetch(dataUrl).then((r) => r.blob());
    return resizeImageToThumbnail(blob);
  }

  /** CSS.escape isn't guaranteed in every embedded environment - a tiny inline fallback for building attribute selectors safely. */
  function cssEscape(value) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
  }

  /** Minimal escaping for interpolating a value into an HTML attribute (e.g. a category name into value="..."). */
  function escapeAttr(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  /** "Crown_Crust.png" / "crown-crust.PNG" / "Crown Crust.jpeg" all collapse
   *  to "crowncrust" - same treatment applied to the item name itself, so
   *  spacing/casing/separator differences between a filename and a menu
   *  item never stop them from matching. */
  function normalizeMatchKey(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9]+/g, '');
  }

  const GALLERY_IMAGE_RE = /\.(png|jpe?g)$/i;

  /**
   * "Auto-Detect Images" - matches named photo candidates to menu
   * items by normalized name (e.g. Crown_Crust.png, crown-crust.png,
   * and "Crown Crust" from the saved gallery all match the item
   * "Crown Crust"), then lets the admin review/apply the matches.
   * Every matched photo goes through the exact same
   * resizeImageToThumbnail() + items.update() path a manual upload
   * uses, so there is no separate image pipeline to maintain.
   *
   * @param {Array<{matchName: string, displayLabel: string, previewUrl: string, getFinalDataUrl: () => Promise<string>, revoke?: () => void}>} candidates
   */
  async function openAutoDetectModal(candidates) {
    const candidateByKey = new Map();
    candidates.forEach((c) => {
      const key = normalizeMatchKey(c.matchName);
      if (!candidateByKey.has(key)) candidateByKey.set(key, c); // first one wins on a duplicate name
    });

    const matches = items.map((item) => ({
      item,
      candidate: candidateByKey.get(normalizeMatchKey(item.name)) || null,
    }));
    const matched = matches.filter((m) => m.candidate);
    const unmatched = matches.filter((m) => !m.candidate);

    function cleanup() {
      candidates.forEach((c) => c.revoke && c.revoke());
    }

    if (matched.length === 0) {
      toaster.error('No item names matched a photo.');
      cleanup();
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-40 flex items-center justify-center p-4';
    overlay.innerHTML = `
      <div class="gallery-scrim scrim-enter absolute inset-0 bg-black/60 backdrop-blur-md"></div>
      <div class="modal-pop relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-surface shadow-modal">
        <div class="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h3 class="font-display text-base font-bold text-ink">Auto-Detect Images</h3>
            <p class="text-xs text-ink-muted">${matched.length} of ${items.length} items matched a photo${unmatched.length ? ` - ${unmatched.length} had no match` : ''}.</p>
          </div>
          <button type="button" id="auto-detect-close" title="Close"
            class="ripple-host flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink">
            <span class="h-4 w-4">${iconMarkup('close')}</span>
          </button>
        </div>
        <div id="auto-detect-body" class="min-h-0 flex-1 overflow-y-auto p-3"></div>
        <div class="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <button type="button" id="auto-detect-cancel"
            class="ripple-host rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-ink-secondary hover:bg-surface-raised">
            Cancel
          </button>
          <button type="button" id="auto-detect-apply"
            class="ripple-host flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-card transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
            Apply
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    function close() {
      cleanup();
      overlay.remove();
    }
    overlay.querySelector('.gallery-scrim').addEventListener('click', close);
    overlay.querySelector('#auto-detect-close').addEventListener('click', close);
    overlay.querySelector('#auto-detect-cancel').addEventListener('click', close);
    attachRipple(overlay.querySelector('#auto-detect-close'));
    attachRipple(overlay.querySelector('#auto-detect-cancel'));

    const bodyEl = overlay.querySelector('#auto-detect-body');
    const applyBtn = overlay.querySelector('#auto-detect-apply');
    attachRipple(applyBtn);

    bodyEl.innerHTML = matched
      .map(({ item, candidate }) => {
        const replacing = !!item.image_path;
        return `
        <label class="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5 mb-2 last:mb-0 cursor-pointer hover:border-accent/40">
          <input type="checkbox" data-item-id="${item.id}" ${replacing ? '' : 'checked'} class="h-4 w-4 flex-shrink-0 accent-accent" />
          <img src="${candidate.previewUrl}" alt="" class="h-10 w-10 flex-shrink-0 rounded-lg object-cover bg-surface-raised" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium text-ink">${item.name}</span>
            <span class="block truncate text-xs text-ink-muted">${candidate.displayLabel}${replacing ? ' - will replace existing photo' : ''}</span>
          </span>
        </label>`;
      })
      .join('');

    // Unmatched item names are intentionally NOT listed here - with a
    // large menu that list can run to dozens of names and both clutters
    // the modal and (before min-h-0 above) could push the Apply button
    // out of view. The header subtitle already gives the admin the count
    // ("N of M items matched a photo - K had no match"), which is enough
    // context without repeating every unmatched name.

    function selectedCount() {
      return bodyEl.querySelectorAll('input[type="checkbox"]:checked').length;
    }
    function updateApplyLabel() {
      const n = selectedCount();
      applyBtn.textContent = n > 0 ? `Apply to ${n} item${n === 1 ? '' : 's'}` : 'Apply';
      applyBtn.disabled = n === 0;
    }
    bodyEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => cb.addEventListener('change', updateApplyLabel));
    updateApplyLabel();

    applyBtn.addEventListener('click', async () => {
      const checkedIds = new Set(
        Array.from(bodyEl.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => Number(cb.dataset.itemId))
      );
      const toApply = matched.filter((m) => checkedIds.has(m.item.id));
      if (toApply.length === 0) return;

      applyBtn.disabled = true;
      applyBtn.textContent = 'Applying...';
      let succeeded = 0;
      let failed = 0;
      for (const { item, candidate } of toApply) {
        try {
          const imageDataUrl = await candidate.getFinalDataUrl();
          if (item.image_path) invalidateItemImage(item.image_path);
          await posApi.items.update(item.id, { imageDataUrl });
          succeeded += 1;
        } catch (err) {
          failed += 1;
        }
      }

      close();
      if (succeeded > 0) toaster.success(`${succeeded} image${succeeded === 1 ? '' : 's'} added${failed ? `, ${failed} failed` : ''}.`);
      else toaster.error('Could not add any images - try again.');
      await refresh();
    });
  }

  /** Turns picked folder Files into Auto-Detect candidates - preview via
   *  object URL, final image via the same resize pipeline a manual
   *  upload gets (never resized twice: gallery candidates below are
   *  already a saved thumbnail, so they skip this step entirely). */
  function candidatesFromFiles(files) {
    return files
      .filter((f) => GALLERY_IMAGE_RE.test(f.name))
      .map((file) => {
        const previewUrl = URL.createObjectURL(file);
        return {
          matchName: file.name,
          displayLabel: file.name,
          previewUrl,
          getFinalDataUrl: () => resizeImageToThumbnail(file),
          revoke: () => URL.revokeObjectURL(previewUrl),
        };
      });
  }

  /** Cheap, no-image-bytes lookup of every distinct photo name
   *  available across the bundled seed-images/ gallery and the
   *  admin's saved custom gallery - the exact same merged source
   *  "Choose from Gallery" (openGalleryPicker) reads from. Used to
   *  count/flag potential matches without fetching any image data;
   *  candidatesFromGallery() below does the real fetch once the admin
   *  actually opens Auto-Detect. Keeping both the toolbar badge and
   *  the chooser's count on this one function is what keeps their
   *  numbers from disagreeing with each other. */
  async function galleryMatchKeys() {
    let seedCats = [];
    try {
      seedCats = await posApi.seedGallery.list();
    } catch {
      seedCats = [];
    }
    let customEntries = [];
    try {
      customEntries = await posApi.customGallery.list();
    } catch {
      customEntries = [];
    }
    const keys = new Set();
    seedCats.forEach((c) => c.images.forEach((filename) => keys.add(normalizeMatchKey(humanizeFilename(filename)))));
    customEntries.forEach((entry) => keys.add(normalizeMatchKey(entry.name)));
    return keys;
  }

  /** Turns the combined bundled seed-images/ gallery and the admin's
   *  saved custom gallery into Auto-Detect candidates - the same
   *  merged source "Choose from Gallery" reads from (see
   *  openGalleryPicker), so any photo the admin can pick for one item
   *  is also a photo Auto-Detect can find for another. A custom photo
   *  wins over a same-named seed photo (the admin chose that specific
   *  photo/name on purpose). Seed photos aren't pre-resized, so they
   *  go through the same resizeImageToThumbnail() pipeline a manual
   *  upload gets; custom gallery entries are already a saved
   *  thumbnail. */
  async function candidatesFromGallery() {
    let seedCats = [];
    try {
      seedCats = await posApi.seedGallery.list();
    } catch {
      seedCats = [];
    }
    let customEntries = [];
    try {
      customEntries = await posApi.customGallery.list();
    } catch {
      customEntries = [];
    }

    const byKey = new Map();
    seedCats.forEach((cat) => {
      cat.images.forEach((filename) => {
        const name = humanizeFilename(filename);
        byKey.set(normalizeMatchKey(name), { name, source: 'seed', category: cat.category, filename });
      });
    });
    // Custom entries are set after seed entries, so a same-named
    // custom photo always overrides the bundled one.
    customEntries.forEach((entry) => {
      byKey.set(normalizeMatchKey(entry.name), { name: entry.name, source: 'custom', filename: entry.filename });
    });

    const resolved = await Promise.all(
      [...byKey.values()].map(async (c) => {
        const dataUrl = c.source === 'seed' ? await posApi.seedGallery.getImage(c.category, c.filename) : await posApi.customGallery.getImage(c.filename);
        if (!dataUrl) return null;
        return {
          matchName: c.name,
          displayLabel: c.source === 'seed' ? `${c.name} (gallery)` : `${c.name} (added photo)`,
          previewUrl: dataUrl,
          getFinalDataUrl: c.source === 'seed' ? () => resizeDataUrlToThumbnail(dataUrl) : async () => dataUrl,
        };
      })
    );
    return resolved.filter(Boolean);
  }

  /** Small action-sheet asking where to source photos from, before
   *  handing off to the shared review/apply modal above. */
  async function openAutoDetectChooser() {
    let galleryCount = 0;
    try {
      galleryCount = (await galleryMatchKeys()).size;
    } catch {
      galleryCount = 0;
    }

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-40 flex items-center justify-center p-4';
    overlay.innerHTML = `
      <div class="gallery-scrim scrim-enter absolute inset-0 bg-black/60 backdrop-blur-md"></div>
      <div class="modal-pop relative flex w-full max-w-sm flex-col rounded-2xl border border-border bg-surface shadow-modal">
        <div class="flex items-center justify-between border-b border-border px-5 py-4">
          <h3 class="font-display text-base font-bold text-ink">Auto-Detect Images</h3>
          <button type="button" id="chooser-close" title="Close"
            class="ripple-host flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink">
            <span class="h-4 w-4">${iconMarkup('close')}</span>
          </button>
        </div>
        <div class="flex flex-col gap-2 p-4">
          <button type="button" id="chooser-gallery" ${galleryCount === 0 ? 'disabled' : ''}
            class="ripple-host flex flex-col items-start gap-0.5 rounded-xl border border-border px-4 py-3 text-left transition-colors hover:border-accent/40 disabled:cursor-not-allowed disabled:opacity-50">
            <span class="text-sm font-medium text-ink">From Gallery</span>
            <span class="text-xs text-ink-muted">${galleryCount > 0 ? `${galleryCount} named photo${galleryCount === 1 ? '' : 's'} available in the gallery` : 'No named photos yet - use "Choose from Gallery" on an item to add one'}</span>
          </button>
          <button type="button" id="chooser-folder"
            class="ripple-host flex flex-col items-start gap-0.5 rounded-xl border border-border px-4 py-3 text-left transition-colors hover:border-accent/40">
            <span class="text-sm font-medium text-ink">From a Folder...</span>
            <span class="text-xs text-ink-muted">Pick a folder of photos named after your items</span>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
    }
    overlay.querySelector('.gallery-scrim').addEventListener('click', close);
    overlay.querySelector('#chooser-close').addEventListener('click', close);
    attachRipple(overlay.querySelector('#chooser-close'));
    attachRippleAll(overlay, '.ripple-host');

    overlay.querySelector('#chooser-gallery').addEventListener('click', async () => {
      close();
      const candidates = await candidatesFromGallery();
      if (candidates.length === 0) {
        toaster.error('No gallery photos yet.');
        return;
      }
      await openAutoDetectModal(candidates);
    });
    overlay.querySelector('#chooser-folder').addEventListener('click', () => {
      close();
      galleryFolderInput.click();
    });
  }


  /**
   * "Manage Categories" - categories are just a free-text column on
   * items (no separate table), so:
   *   - Rename edits that text across every item with the old value.
   *   - Delete offers three outcomes for the items left behind: move
   *     them to another category, move them to "Uncategorized", or
   *     delete the category together with every item in it. Every
   *     delete path (including "just" removing the category label)
   *     goes through a plain-language window.confirm() as a second,
   *     final confirmation before anything happens.
   */
  async function openManageCategoriesModal() {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-40 flex items-center justify-center p-4';
    overlay.innerHTML = `
      <div class="gallery-scrim scrim-enter absolute inset-0 bg-black/60 backdrop-blur-md"></div>
      <div class="modal-pop relative flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-border bg-surface shadow-modal">
        <div class="flex items-center justify-between border-b border-border px-5 py-4">
          <h3 class="font-display text-base font-bold text-ink">Manage Categories</h3>
          <button type="button" id="manage-cat-close" title="Close"
            class="ripple-host flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink">
            <span class="h-4 w-4">${iconMarkup('close')}</span>
          </button>
        </div>
        <div id="manage-cat-body" class="flex-1 overflow-y-auto p-3"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
    }
    overlay.querySelector('.gallery-scrim').addEventListener('click', close);
    overlay.querySelector('#manage-cat-close').addEventListener('click', close);
    attachRipple(overlay.querySelector('#manage-cat-close'));

    const bodyEl = overlay.querySelector('#manage-cat-body');

    function itemCountFor(cat) {
      return items.filter((i) => i.category === cat).length;
    }

    function closeExpanders(except) {
      bodyEl.querySelectorAll('.cat-expand').forEach((el) => {
        if (el !== except) {
          el.classList.add('hidden');
          el.innerHTML = '';
        }
      });
    }

    function wireRowActions() {
      bodyEl.querySelectorAll('.cat-row').forEach((row) => {
        const cat = row.dataset.category;
        const expand = row.querySelector('.cat-expand');

        row.querySelector('.cat-rename-btn').addEventListener('click', () => {
          const alreadyOpenForRename = !expand.classList.contains('hidden') && expand.dataset.mode === 'rename';
          closeExpanders();
          if (alreadyOpenForRename) return;
          expand.dataset.mode = 'rename';
          expand.classList.remove('hidden');
          expand.innerHTML = `
            <div class="flex items-center gap-2">
              <input type="text" value="${escapeAttr(cat)}" maxlength="60"
                class="min-w-0 flex-1 rounded-lg border border-border px-2.5 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
              <button type="button" class="cat-rename-save ripple-host rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover">Save</button>
            </div>
          `;
          const input = expand.querySelector('input');
          input.focus();
          input.select();
          attachRipple(expand.querySelector('.cat-rename-save'));
          async function saveRename() {
            const newName = input.value.trim();
            if (!newName) {
              toaster.error('Category name cannot be empty.');
              return;
            }
            if (newName === cat) {
              expand.classList.add('hidden');
              return;
            }
            try {
              const result = await posApi.items.renameCategory(cat, newName);
              toaster.success(`Renamed to "${newName}" (${result.renamed} item${result.renamed === 1 ? '' : 's'}).`);
              await refresh();
              renderList();
            } catch (err) {
              toaster.error(err.message);
            }
          }
          expand.querySelector('.cat-rename-save').addEventListener('click', saveRename);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveRename();
          });
        });

        row.querySelector('.cat-delete-btn').addEventListener('click', () => {
          const alreadyOpenForDelete = !expand.classList.contains('hidden') && expand.dataset.mode === 'delete';
          closeExpanders();
          if (alreadyOpenForDelete) return;
          expand.dataset.mode = 'delete';
          expand.classList.remove('hidden');

          const others = categories.filter((c) => c !== cat);
          const count = itemCountFor(cat);
          const radioName = `del-mode-${cssEscape(cat)}`;
          expand.innerHTML = `
            <div class="flex flex-col gap-2 rounded-lg bg-surface-raised p-3">
              <label class="flex items-start gap-2 text-xs text-ink-secondary">
                <input type="radio" name="${radioName}" value="move" ${others.length ? 'checked' : 'disabled'} class="mt-0.5 h-3.5 w-3.5 accent-accent" />
                <span class="flex-1">
                  Move ${count} item${count === 1 ? '' : 's'} to:
                  <select class="cat-move-target mt-1 block w-full rounded-lg border border-border px-2 py-1.5 text-xs" ${others.length ? '' : 'disabled'}>
                    ${others.map((c) => `<option value="${escapeAttr(c)}">${c}</option>`).join('')}
                  </select>
                </span>
              </label>
              <label class="flex items-center gap-2 text-xs text-ink-secondary">
                <input type="radio" name="${radioName}" value="uncategorize" ${others.length ? '' : 'checked'} class="h-3.5 w-3.5 accent-accent" />
                Remove category (move items to "Uncategorized")
              </label>
              <label class="flex items-center gap-2 text-xs text-red-600">
                <input type="radio" name="${radioName}" value="delete-items" class="h-3.5 w-3.5 accent-red-600" />
                Permanently delete this category and all ${count} item${count === 1 ? '' : 's'} in it
              </label>
              <div class="flex justify-end gap-2 pt-1">
                <button type="button" class="cat-delete-cancel ripple-host rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:bg-surface">Cancel</button>
                <button type="button" class="cat-delete-confirm ripple-host rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700">Continue</button>
              </div>
            </div>
          `;
          attachRippleAll(expand, '.ripple-host');

          expand.querySelector('.cat-delete-cancel').addEventListener('click', () => {
            expand.classList.add('hidden');
            expand.innerHTML = '';
          });

          expand.querySelector('.cat-delete-confirm').addEventListener('click', async () => {
            const mode = expand.querySelector(`input[name="${radioName}"]:checked`)?.value;
            if (!mode) return;

            let message;
            let options;
            if (mode === 'move') {
              const target = expand.querySelector('.cat-move-target')?.value;
              if (!target) {
                toaster.error('Choose a category to move these items to.');
                return;
              }
              message = `Move ${count} item(s) from "${cat}" to "${target}"?`;
              options = { mode: 'move', moveTo: target };
            } else if (mode === 'uncategorize') {
              message = `Move ${count} item(s) from "${cat}" to "Uncategorized"?`;
              options = { mode: 'move', moveTo: 'Uncategorized' };
            } else {
              message = `Permanently delete "${cat}" and all ${count} item(s) in it? This cannot be undone.`;
              options = { mode: 'delete-items' };
            }

            // Second, final confirmation - the picker above is step one.
            if (!window.confirm(message)) return;

            try {
              const result = await posApi.items.deleteCategory(cat, options);
              if (options.mode === 'move') {
                toaster.success(`Moved ${result.moved} item(s) to "${options.moveTo}".`);
              } else {
                let msg = `Deleted "${cat}" and ${result.deleted} item(s).`;
                if (result.blocked > 0) {
                  msg += ` ${result.blocked} item(s) couldn't be deleted (they're in past orders): ${result.blockedNames.join(', ')}.`;
                }
                toaster.success(msg);
              }
              await refresh();
              renderList();
            } catch (err) {
              toaster.error(err.message);
            }
          });
        });
      });
    }

    function renderList() {
      bodyEl.innerHTML =
        categories
          .map(
            (cat) => `
        <div class="cat-row mb-2 rounded-xl border border-border p-3 last:mb-0" data-category="${escapeAttr(cat)}">
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-ink">${cat}</p>
              <p class="text-xs text-ink-muted">${itemCountFor(cat)} item${itemCountFor(cat) === 1 ? '' : 's'}</p>
            </div>
            <div class="flex flex-shrink-0 items-center gap-1.5">
              <button type="button" class="cat-rename-btn ripple-host rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/40 hover:text-ink">Rename</button>
              <button type="button" class="cat-delete-btn ripple-host rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-red-600 hover:border-red-300 hover:bg-red-50">Delete</button>
            </div>
          </div>
          <div class="cat-expand mt-3 hidden"></div>
        </div>`
          )
          .join('') || '<p class="p-3 text-sm text-ink-muted">No categories yet.</p>';

      attachRippleAll(bodyEl, '.ripple-host');
      wireRowActions();
    }

    renderList();
  }

  removeImageBtn.addEventListener('click', () => {
    pendingImageDataUrl = null;
    removeExistingImage = true;
    setPreview(null);
  });

  function renderVariantRows() {
    if (variantRows.length === 0) {
      variantRowsHost.innerHTML = `<p class="text-xs text-ink-muted">No price options yet - this item will use a single price.</p>`;
      return;
    }
    variantRowsHost.innerHTML = variantRows
      .map(
        (row) => `
      <div class="variant-row flex items-center gap-2" data-row-id="${row.id}">
        <input type="text" class="variant-label flex-1 rounded-lg border border-border px-2.5 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
          placeholder="Label (e.g. Medium)" value="${row.label}" />
        <input type="number" min="0" step="0.01" class="variant-price w-24 rounded-lg border border-border px-2.5 py-1.5 text-sm font-nums focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
          placeholder="Price" value="${row.price}" />
        <button type="button" class="remove-variant-btn ripple-host flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-accent">
          <span class="h-3.5 w-3.5">${iconMarkup('close')}</span>
        </button>
      </div>`
      )
      .join('');

    variantRowsHost.querySelectorAll('.variant-row').forEach((rowEl) => {
      const id = Number(rowEl.dataset.rowId);
      rowEl.querySelector('.variant-label').addEventListener('input', (e) => {
        const row = variantRows.find((r) => r.id === id);
        if (row) row.label = e.target.value;
      });
      rowEl.querySelector('.variant-price').addEventListener('input', (e) => {
        const row = variantRows.find((r) => r.id === id);
        if (row) row.price = e.target.value;
      });
      rowEl.querySelector('.remove-variant-btn').addEventListener('click', () => {
        variantRows = variantRows.filter((r) => r.id !== id);
        renderVariantRows();
      });
    });
    attachRippleAll(variantRowsHost, '.remove-variant-btn');
  }

  addVariantBtn.addEventListener('click', () => {
    variantRows.push({ id: nextVariantRowId++, label: '', price: '' });
    renderVariantRows();
  });

  async function openPanel(item = null) {
    editingItem = item;
    pendingImageDataUrl = null;
    removeExistingImage = false;
    panelTitle.textContent = item ? 'Edit Item' : 'Add Item';
    panelForm.reset();
    setPreview(null);
    variantRows = (item?.priceVariants || []).map((v) => ({ id: nextVariantRowId++, label: v.label, price: v.price }));
    renderVariantRows();
    if (item) {
      panelForm.sku.value = item.sku;
      panelForm.sku.disabled = true;
      panelForm.name.value = item.name;
      panelForm.nameUrdu.value = item.name_urdu || '';
      setCategoryValue(item.category);
      panelForm.price.value = item.price;
      panelForm.description.value = item.description || '';
      if (item.image_path) {
        posApi.items.getImage(item.image_path).then((url) => {
          if (url) setPreview(url);
        });
      }
    } else {
      panelForm.sku.disabled = false;
      setCategoryValue('');
    }
    closeCategoryDropdown();
    closeNewCategoryRow();
    panelOverlay.classList.remove('hidden');
    // Double rAF: the scrim fade and panel slide both need one paint with
    // the starting state committed before adding the "open" classes, or
    // the browser collapses it into a single frame (the "jerk" this fixes).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        panelScrim.classList.add('scrim-enter');
        panel.classList.add('is-open');
      });
    });
    panelForm.querySelector(item ? '[name="name"]' : '[name="sku"]').focus();
  }

  function closePanel() {
    panel.classList.remove('is-open');
    panelScrim.classList.remove('scrim-enter');
    setTimeout(() => panelOverlay.classList.add('hidden'), 300);
  }

  addBtn.addEventListener('click', () => openPanel(null));
  manageCategoriesBtn.addEventListener('click', () => openManageCategoriesModal());
  autoDetectBtn.addEventListener('click', () => openAutoDetectChooser());
  galleryFolderInput.addEventListener('change', async () => {
    const files = Array.from(galleryFolderInput.files || []);
    galleryFolderInput.value = ''; // allow picking the same folder again later
    if (files.length === 0) return;
    const candidates = candidatesFromFiles(files);
    if (candidates.length === 0) {
      toaster.error('That folder has no .png/.jpg/.jpeg files.');
      return;
    }
    await openAutoDetectModal(candidates);
  });
  panelOverlay.querySelector('#panel-close').addEventListener('click', closePanel);
  panelOverlay.querySelector('#panel-cancel').addEventListener('click', closePanel);
  panelScrim.addEventListener('click', closePanel);
  attachRipple(panelOverlay.querySelector('#panel-close'));
  attachRipple(panelOverlay.querySelector('#panel-cancel'));

  panelForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Hidden inputs are exempt from native HTML5 "required" validation,
    // so the category picker needs its own explicit check here.
    if (!categoryHiddenInput.value.trim()) {
      toaster.error('Pick or add a category first.');
      categorySelectBtn.focus();
      return;
    }

    const incompleteRow = variantRows.find((r) => {
      const hasLabel = r.label.trim().length > 0;
      const hasPrice = r.price !== '' && Number.isFinite(Number(r.price)) && Number(r.price) >= 0;
      return hasLabel !== hasPrice;
    });
    if (incompleteRow) {
      toaster.error('Each price option needs both a label and a price - remove any incomplete rows.');
      return;
    }
    const priceVariants = variantRows
      .filter((r) => r.label.trim() && r.price !== '')
      .map((r) => ({ label: r.label.trim(), price: Number(r.price) }));

    const formData = new FormData(panelForm);
    const payload = {
      sku: String(formData.get('sku') || '').trim(),
      name: String(formData.get('name')).trim(),
      nameUrdu: String(formData.get('nameUrdu') || '').trim(),
      category: String(formData.get('category')).trim(),
      price: Number(formData.get('price')),
      description: String(formData.get('description') || '').trim(),
      priceVariants,
    };
    if (pendingImageDataUrl) payload.imageDataUrl = pendingImageDataUrl;
    if (removeExistingImage) payload.removeImage = true;

    try {
      if (editingItem) {
        if (editingItem.image_path) invalidateItemImage(editingItem.image_path);
        await posApi.items.update(editingItem.id, payload);
        toaster.success(`"${payload.name}" updated.`);
      } else {
        await posApi.items.create(payload);
        toaster.success(`"${payload.name}" added to the menu.`);
      }

      closePanel();
      await refresh();
    } catch (err) {
      toaster.error(err.message);
    }
  });

  function renderTabs() {
    const tabs = ['All', ...categories];
    tabsEl.innerHTML = tabs
      .map(
        (cat) => `
        <button type="button" data-category="${cat}"
          class="tab-btn ripple-host rounded-full border px-3.5 py-1.5 text-sm transition-colors
                 ${
                   cat === activeCategory
                     ? 'border-accent bg-accent/10 text-accent'
                     : 'border-border text-ink-secondary hover:border-accent/30'
                 }">
          ${cat}
        </button>`
      )
      .join('');
    tabsEl.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeCategory = btn.dataset.category;
        renderTabs();
        smoothUpdate(tableEl, renderTable);
      });
    });
    attachRippleAll(tabsEl, '.tab-btn');
  }

  function renderTable() {
    let visible = activeCategory === 'All' ? items : items.filter((i) => i.category === activeCategory);
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      visible = visible.filter((i) => i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q));
    }

    if (visible.length === 0) {
      tableEl.innerHTML = `
        <div class="flex flex-col items-center justify-center gap-2 bg-surface-raised px-6 py-16 text-center">
          <p class="font-display text-sm font-bold text-ink">${items.length === 0 ? 'No items yet' : 'No items match'}</p>
          <p class="text-sm text-ink-secondary">${items.length === 0 ? 'Add your first menu item to get started.' : 'Try a different search or category.'}</p>
        </div>`;
      return;
    }

    tableEl.innerHTML = `
      <table class="w-full text-left text-sm">
        <thead class="bg-surface-raised text-xs uppercase tracking-wide text-ink-muted">
          <tr>
            <th class="px-4 py-3 font-medium">Item</th>
            <th class="px-4 py-3 font-medium">Category</th>
            <th class="px-4 py-3 font-medium">Price</th>
            <th class="px-4 py-3 font-medium">Stock</th>
            <th class="px-4 py-3 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${visible
            .map((item) => {
              const t = toggleClasses(!!item.is_available);
              const hasVariants = (item.priceVariants || []).length > 0;
              return `
            <tr class="border-t border-border ${item.is_available ? '' : 'opacity-60'}">
              <td class="px-4 py-3">
                <div class="flex items-center gap-3">
                  ${itemThumb(item)}
                  <div>
                    <div class="font-medium text-ink">${item.name}</div>
                    <div class="text-xs text-ink-muted">${item.sku}</div>
                  </div>
                </div>
              </td>
              <td class="px-4 py-3 text-ink-secondary">${item.category}</td>
              <td class="px-4 py-3">
                ${
                  hasVariants
                    ? `<span class="font-nums text-ink">${priceVariantSummary(item)}</span>`
                    : `<input type="number" min="0" step="0.01" data-price-id="${item.id}" value="${item.price}"
                         class="w-24 rounded-lg border border-transparent bg-transparent px-2 py-1 font-nums text-ink hover:border-border focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />`
                }
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <button type="button" data-toggle-id="${item.id}" data-current="${item.is_available}" class="${t.track}">
                    <span class="${t.knob}"></span>
                  </button>
                  <span class="${t.text}">
                    ${item.is_available ? 'Available' : 'Out of stock'}
                  </span>
                </div>
              </td>
              <td class="px-4 py-3 text-right">
                <button type="button" data-edit-id="${item.id}" title="Edit"
                  class="ripple-host mr-1 inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-accent">
                  <span class="h-4 w-4">✎</span>
                </button>
                <button type="button" data-delete-id="${item.id}" title="Remove"
                  class="ripple-host inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-accent/10 hover:text-accent">
                  <span class="h-4 w-4">${iconMarkup('close')}</span>
                </button>
              </td>
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    `;

    hydrateItemImages(tableEl);

    tableEl.querySelectorAll('[data-price-id]').forEach((input) => {
      let originalValue = input.value;
      input.addEventListener('focus', () => (originalValue = input.value));
      const commit = async () => {
        const id = Number(input.dataset.priceId);
        const price = Number(input.value);
        if (!Number.isFinite(price) || price < 0 || String(price) === originalValue) return;
        try {
          await posApi.items.update(id, { price });
          const item = items.find((i) => i.id === id);
          if (item) item.price = price;
          toaster.success('Price updated.');
        } catch (err) {
          input.value = originalValue;
          toaster.error(err.message);
        }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
    });

    tableEl.querySelectorAll('.toggle-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.toggleId);
        const next = btn.dataset.current !== '1';
        try {
          await posApi.items.setAvailability(id, next);
          await refresh();
        } catch (err) {
          toaster.error(err.message);
        }
      });
    });

    tableEl.querySelectorAll('[data-edit-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = items.find((i) => i.id === Number(btn.dataset.editId));
        if (item) openPanel(item);
      });
    });

    tableEl.querySelectorAll('[data-delete-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.deleteId);
        const target = items.find((i) => i.id === id);
        const label = target ? `"${target.name}"` : 'this item';
        const confirmed = await confirmAction({
          title: `Permanently delete ${label}?`,
          message: 'This removes it from the menu for good. Past orders keep showing it exactly as it was sold - only Menu Setup loses it. Prefer "Out of Stock" instead if you just want to stop selling it for now.',
          confirmLabel: 'Delete item',
          tone: 'danger',
        });
        if (!confirmed) return;
        try {
          await posApi.items.remove(id);
          toaster.success('Item removed.');
          await refresh();
        } catch (err) {
          toaster.error(err.message);
        }
      });
    });

    attachRippleAll(tableEl, '.ripple-host');
  }

  async function updateAutoDetectBadge() {
    const badge = root.querySelector('#auto-detect-badge');
    if (!badge) return;
    try {
      const galleryKeys = await galleryMatchKeys();
      if (galleryKeys.size === 0) {
        badge.classList.add('hidden');
        return;
      }
      const readyCount = items.filter((item) => !item.image_path && galleryKeys.has(normalizeMatchKey(item.name))).length;
      if (readyCount > 0) {
        badge.textContent = readyCount > 9 ? '9+' : String(readyCount);
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    } catch {
      badge.classList.add('hidden');
    }
  }

  async function refresh() {
    try {
      [items, categories] = await Promise.all([posApi.items.list(), posApi.items.listCategories()]);
      if (activeCategory !== 'All' && !categories.includes(activeCategory)) activeCategory = 'All';
      renderTabs();
      smoothUpdate(tableEl, renderTable);
      updateAutoDetectBadge();
    } catch (err) {
      toaster.error('Failed to load menu items: ' + err.message);
    }
  }

  refresh();

  root._cleanup = () => {
    // panelOverlay now lives on document.body (see the comment where it
    // was appended, above) specifically so it's a true full-viewport
    // fixed overlay unaffected by the route-layer's transform. That
    // means it's no longer a descendant of `root`, so removing `root`
    // on navigation would otherwise leak it as an orphaned, invisible
    // node sitting on <body> forever - and worse, coming back to Menu
    // Setup later would append a second one on top of it. Remove it
    // explicitly here, whether or not it was open when we navigated away.
    panelOverlay.remove();
  };

  return root;
}
