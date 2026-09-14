'use strict';

import { posApi } from '../shell/posApi.js';
import { iconMarkup } from '../shell/icons.js';
import { attachRipple } from '../shell/ripple.js';
import { toaster } from '../shell/toast.js';
import { searchBarHtml, wireSearchBar } from '../shell/searchBar.js';

const GROUP_SIZE = 15; // must match campaignStore.CONTACTS_PER_GROUP on the main-process side

const CUSTOMER_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'regular', label: 'Regular' },
  { id: 'high_spender', label: 'High Spenders' },
  { id: 'new', label: 'New' },
  { id: 'inactive', label: "Haven't Ordered" },
];

function card(title, bodyHtml, icon) {
  return `
    <section class="rounded-2xl border border-border bg-surface p-5">
      <div class="mb-4 flex items-center gap-2">
        ${icon ? `<span class="h-4 w-4 text-accent">${iconMarkup(icon)}</span>` : ''}
        <h2 class="font-display text-sm font-bold text-ink">${title}</h2>
      </div>
      ${bodyHtml}
    </section>`;
}

/** Applies the same {name} / greeting logic the main process uses, so the preview matches exactly what gets sent. */
function personalizeMessage(template, name) {
  const firstName = String(name || '').trim().split(/\s+/)[0] || 'Customer';
  if (template.includes('{name}')) return template.split('{name}').join(firstName);
  return `Salam ${firstName} Sb! ${template}`;
}

function connectionBadge(status) {
  const map = {
    DISCONNECTED: { tone: 'bg-border-strong/40 text-ink-muted', dot: 'bg-ink-muted', label: 'Not connected' },
    INITIALIZING: { tone: 'bg-accent/10 text-accent', dot: 'bg-accent animate-pulse', label: 'Starting...' },
    QR: { tone: 'bg-accent/10 text-accent', dot: 'bg-accent animate-pulse', label: 'Scan QR code' },
    AUTHENTICATED: { tone: 'bg-accent/10 text-accent', dot: 'bg-accent animate-pulse', label: 'Signing in...' },
    READY: { tone: 'bg-[#16A34A]/10 text-[#16A34A]', dot: 'bg-[#16A34A]', label: 'Connected' },
    RECONNECTING: { tone: 'bg-[#DC2626]/10 text-[#DC2626]', dot: 'bg-[#DC2626] animate-pulse', label: 'Reconnecting...' },
    AUTH_FAILURE: { tone: 'bg-[#DC2626]/10 text-[#DC2626]', dot: 'bg-[#DC2626]', label: 'Connection failed' },
  };
  const s = map[status] || map.DISCONNECTED;
  return `
    <span class="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ${s.tone}">
      <span class="h-1.5 w-1.5 rounded-full ${s.dot}"></span>
      ${s.label}
    </span>`;
}

const RUN_STATE_PILL = {
  running: { tone: 'bg-accent/10 text-accent', label: 'Sending...' },
  stopped: { tone: 'bg-border-strong/40 text-ink-secondary', label: 'Paused' },
  completed: { tone: 'bg-[#16A34A]/10 text-[#16A34A]', label: 'Completed' },
};

/** Formats an ms duration as "9m 12s" / "42s" for the inter-group countdown. */
function formatCountdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function renderWhatsappDeals() {
  const root = document.createElement('div');
  root.className = 'flex h-full w-full overflow-hidden bg-surface';

  // ---- state: connection ----
  let connectionStatus = 'DISCONNECTED';
  let qrDataUrl = null;
  let statusMessage = null;

  let allCustomers = [];
  let customerSearch = '';
  let customerFilter = 'all';
  let selectedIds = new Set();
  let collapsedGroups = new Set(); // group indices collapsed in the "Select Customers" list

  let dealImagePath = null; // absolute path - a freshly-picked file, or a re-sent past campaign's image
  let dealImageRelativePath = null; // userData-relative path - a saved template's image
  let dealImageFile = null; // the actual File object, kept only so "Save as Template" can re-read its bytes
  let dealImagePreviewUrl = null; // blob: URL (fresh pick) or data: URL (loaded from template)
  let messageTemplate = "our {name}, don't miss today's special deal! Reply to this message to order.";

  // ---- state: saved templates ----
  let templates = [];
  let selectedTemplateId = null;
  let showSaveTemplateForm = false;
  let savingTemplate = false;

  // ---- state: the ONE in-memory/disk-snapshot campaign session ----
  // Mirrors electron/whatsapp/campaignStore.js's shape. Never touches a
  // database - see that file's header comment. Cleared by "New Campaign".
  let session = null;
  let progressFilter = 'all'; // 'all' | 'remaining' | 'sent' | 'failed'
  let countdownTimer = null;

  let unsubscribeEvents = null;

  // Three columns, left to right: compose (connection + message, fixed
  // width - a form doesn't need to stretch), progress (flex-1 - this is
  // the one that benefits from breathing room once a send is running),
  // customers (fixed-width aside, full height, mirrors the New Order
  // page's Cart panel with its own header/list/sticky-footer).
  root.innerHTML = `
    <section class="flex h-full w-[400px] flex-shrink-0 flex-col overflow-y-auto border-r border-border px-6 py-6">
      <header class="mb-5">
        <h1 class="font-display text-xl font-bold text-ink">WhatsApp Deal Sender</h1>
        <p class="text-sm text-ink-secondary">Compose your deal, then pick customers on the right - "Send All" queues them in groups of ${GROUP_SIZE} with randomized gaps so it never looks automated.</p>
      </header>
      <div class="flex flex-col gap-5">
        <div id="connection-card"></div>
        <div id="message-card"></div>
      </div>
    </section>

    <section class="flex h-full flex-1 flex-col overflow-y-auto border-r border-border px-6 py-6">
      <div id="progress-card"></div>
    </section>

    <aside class="flex h-full w-[380px] flex-shrink-0 flex-col overflow-hidden bg-surface-raised">
      <div class="border-b border-border p-5">
        <h2 class="font-display text-sm font-bold text-ink">Select Customers</h2>
        <p class="mt-0.5 text-xs text-ink-secondary">Grouped in batches of ${GROUP_SIZE} - tick a group's box to select everyone in it.</p>
        <div id="wa-filter-row" class="mt-3 flex flex-wrap gap-1.5"></div>
        <div class="mt-3">${searchBarHtml({ placeholder: 'Search by name or phone', id: 'wa-customer-search', value: customerSearch })}</div>
      </div>
      <div id="wa-customer-list" class="flex-1 overflow-y-auto p-3"></div>
      <div id="wa-selection-footer" class="border-t border-border bg-surface p-5"></div>
    </aside>
  `;
  wireSearchBar(root, (value) => {
    customerSearch = value;
    loadCustomers();
  });

  // =================================================================
  // Connection card - QR / status / logout
  // =================================================================
  function renderConnectionCard() {
    const container = root.querySelector('#connection-card');
    const showQr = connectionStatus === 'QR' && qrDataUrl;
    container.innerHTML = card(
      'WhatsApp Connection',
      `
      <div class="mb-4 flex items-center justify-between">
        ${connectionBadge(connectionStatus)}
        ${
          connectionStatus === 'READY'
            ? `<button type="button" id="wa-logout-btn" class="ripple-host rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">Log out</button>`
            : ''
        }
      </div>
      ${
        showQr
          ? `<div class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-surface-raised p-4">
              <img src="${qrDataUrl}" alt="WhatsApp QR code" class="h-48 w-48 rounded-lg bg-white p-2" />
              <p class="text-center text-xs text-ink-secondary">Open WhatsApp on your phone &rarr; Linked Devices &rarr; Link a Device, then scan this code.</p>
            </div>`
          : ''
      }
      ${statusMessage && !showQr ? `<p class="text-xs text-ink-muted">${statusMessage}</p>` : ''}
      ${
        connectionStatus === 'DISCONNECTED' || connectionStatus === 'AUTH_FAILURE'
          ? `<button type="button" id="wa-connect-btn" class="ripple-host mt-3 w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover">
              Connect WhatsApp
            </button>`
          : ''
      }
      ${
        connectionStatus === 'AUTH_FAILURE'
          ? `<button type="button" id="wa-view-logs-btn" class="ripple-host mt-2 w-fit rounded-lg bg-[#DC2626]/10 px-3 py-1.5 text-xs font-medium text-[#DC2626] hover:bg-[#DC2626]/20">
              View Logs
            </button>`
          : ''
      }
      `,
      'whatsapp'
    );

    const connectBtn = container.querySelector('#wa-connect-btn');
    if (connectBtn) {
      attachRipple(connectBtn);
      connectBtn.addEventListener('click', async () => {
        connectBtn.disabled = true;
        connectBtn.textContent = 'Starting...';
        try {
          await posApi.whatsapp.init();
        } catch (err) {
          toaster.error(err.message);
          connectBtn.disabled = false;
          connectBtn.textContent = 'Connect WhatsApp';
        }
      });
    }
    const viewLogsBtn = container.querySelector('#wa-view-logs-btn');
    if (viewLogsBtn) {
      attachRipple(viewLogsBtn);
      viewLogsBtn.addEventListener('click', () => openLogsModal());
    }
    const logoutBtn = container.querySelector('#wa-logout-btn');
    if (logoutBtn) {
      attachRipple(logoutBtn);
      logoutBtn.addEventListener('click', async () => {
        if (isRunning()) {
          toaster.error('Stop the current send before logging out.');
          return;
        }
        try {
          await posApi.whatsapp.logout();
          toaster.success('WhatsApp session ended.');
        } catch (err) {
          toaster.error(err.message);
        }
      });
    }
  }

  /** Shows exactly what happened, in order, newest first - so instead of
   *  a single generic "not connected" line, the operator can see the
   *  real reason (timeout, rejected login, no internet, etc.) themselves. */
  async function openLogsModal() {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-50 flex items-center justify-center';
    overlay.innerHTML = `
      <div class="gallery-scrim scrim-enter absolute inset-0 bg-black/60 backdrop-blur-md"></div>
      <div class="relative z-10 flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-surface p-5 shadow-modal">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="font-display text-base font-bold text-ink">Connection Logs</h3>
          <button type="button" id="wa-logs-close" class="ripple-host flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink">
            <span class="h-4 w-4">${iconMarkup('close')}</span>
          </button>
        </div>
        <div id="wa-logs-body" class="flex-1 overflow-y-auto rounded-xl border border-border"></div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.gallery-scrim').addEventListener('click', close);
    overlay.querySelector('#wa-logs-close').addEventListener('click', close);
    attachRipple(overlay.querySelector('#wa-logs-close'));

    const bodyEl = overlay.querySelector('#wa-logs-body');
    let logs = [];
    try {
      logs = await posApi.whatsapp.getLogs();
    } catch (err) {
      bodyEl.innerHTML = `<p class="p-4 text-center text-xs text-ink-muted">Could not load the logs: ${err.message}</p>`;
      return;
    }
    if (logs.length === 0) {
      bodyEl.innerHTML = `<p class="p-4 text-center text-xs text-ink-muted">No connection activity yet.</p>`;
      return;
    }
    bodyEl.innerHTML = logs
      .map((entry) => {
        const time = new Date(entry.time).toLocaleString();
        return `
          <div class="border-b border-border px-4 py-2.5 last:border-b-0">
            <p class="text-sm text-ink">${entry.message}</p>
            <p class="mt-0.5 text-[11px] text-ink-muted">${time}</p>
          </div>`;
      })
      .join('');
  }

  // =================================================================
  // Customers card - quick filters + search + multi-select (no cap -
  // "Send All" auto-splits the selection into groups of GROUP_SIZE)
  // =================================================================
  async function loadCustomers() {
    try {
      const result = await posApi.customers.list({ search: customerSearch || null, limit: 500, filter: customerFilter });
      allCustomers = result.rows || result || [];
    } catch (err) {
      toaster.error(`Could not load customers: ${err.message}`);
      allCustomers = [];
    }
    renderCustomerListOnly();
    renderSelectionFooter();
  }

  /** "One click gets you a relevant group" - lets a non-technical admin
   *  skip manually checking boxes for the most common targeting needs. */
  function renderFilterRow() {
    const row = root.querySelector('#wa-filter-row');
    if (!row) return;
    row.innerHTML = CUSTOMER_FILTERS.map(
      (f) => `
      <button type="button" data-filter="${f.id}"
        class="ripple-host rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
          customerFilter === f.id ? 'bg-accent text-white' : 'border border-border text-ink-secondary hover:border-accent/30 hover:text-accent'
        }">
        ${f.label}
      </button>`
    ).join('');
    row.querySelectorAll('[data-filter]').forEach((btn) => {
      attachRipple(btn);
      btn.addEventListener('click', () => {
        if (customerFilter === btn.dataset.filter) return;
        customerFilter = btn.dataset.filter;
        renderFilterRow();
        loadCustomers();
      });
    });
  }

  /** Splits a flat array into fixed-size chunks - used to mirror the
   *  exact 15-per-group split the backend queue will use, so what the
   *  admin selects here maps 1:1 onto what they'll see in the progress
   *  timeline later (same "Group 1/2/3..." numbering both places). */
  function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  /** Re-renders only the grouped list rows - never touches the search input, so it never steals focus while the admin is typing. */
  function renderCustomerListOnly() {
    const listEl = root.querySelector('#wa-customer-list');
    if (!listEl) return;

    const visible = allCustomers.filter((c) => !!c.phone);
    const groups = chunkArray(visible, GROUP_SIZE);

    listEl.innerHTML =
      visible.length === 0
        ? `<p class="px-2 py-6 text-center text-sm text-ink-muted">No customers match this filter.</p>`
        : `<div class="flex flex-col gap-2">
            ${groups
              .map((group, groupIndex) => {
                const selectedInGroup = group.filter((c) => selectedIds.has(c.id)).length;
                const collapsed = collapsedGroups.has(groupIndex);
                const groupFullySelected = selectedInGroup === group.length;
                return `
              <div class="wa-select-group overflow-hidden rounded-xl border ${
                groupFullySelected ? 'border-accent/40' : 'border-border'
              } bg-surface" data-group-index="${groupIndex}">
                <div class="flex items-center gap-2.5 px-3 py-2.5 ${groupFullySelected ? 'bg-accent/5' : 'bg-surface-raised'}">
                  <input type="checkbox" data-select-group="${groupIndex}" title="Select everyone in this group"
                    class="h-5 w-5 flex-shrink-0 cursor-pointer rounded border-border text-accent focus:ring-accent/30" />
                  <button type="button" data-toggle-group="${groupIndex}" title="${collapsed ? 'Expand' : 'Collapse'}"
                    class="ripple-host flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    <span class="text-sm font-semibold text-ink">Group ${groupIndex + 1}</span>
                    <span class="truncate text-xs text-ink-muted">&middot; ${group.length} customer${group.length === 1 ? '' : 's'}</span>
                  </button>
                  <span class="flex-shrink-0 rounded-full px-2 py-0.5 font-nums text-[11px] font-medium ${
                    selectedInGroup === 0 ? 'bg-surface text-ink-muted' : groupFullySelected ? 'bg-accent text-white' : 'bg-accent/10 text-accent'
                  }">${selectedInGroup}/${group.length}</span>
                  <button type="button" data-toggle-group="${groupIndex}" title="${collapsed ? 'Expand' : 'Collapse'}"
                    class="ripple-host flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-ink-muted transition-transform hover:text-ink ${
                      collapsed ? '-rotate-90' : ''
                    }">
                    <span class="h-3.5 w-3.5">${iconMarkup('chevronDown')}</span>
                  </button>
                </div>
                <div class="wa-select-group-body ${collapsed ? 'hidden' : ''} flex flex-col divide-y divide-border border-t border-border">
                  ${group
                    .map((c) => {
                      const checked = selectedIds.has(c.id);
                      return `
                    <label class="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-surface-raised">
                      <input type="checkbox" data-customer-id="${c.id}" ${checked ? 'checked' : ''}
                        class="h-4 w-4 flex-shrink-0 rounded border-border text-accent focus:ring-accent/30" />
                      <span class="min-w-0 flex-1">
                        <span class="block truncate font-medium text-ink">${c.name}</span>
                        <span class="block font-nums text-xs text-ink-muted">${c.phone}</span>
                      </span>
                    </label>`;
                    })
                    .join('')}
                </div>
              </div>`;
              })
              .join('')}
          </div>`;

    // Per-group "select all in this group" checkbox - tri-state
    // (checked / unchecked / indeterminate) reflects how many of the
    // 15 are currently selected, so the admin can tell at a glance
    // whether a group is fully, partly, or not at all selected.
    listEl.querySelectorAll('[data-select-group]').forEach((input) => {
      const groupIndex = Number(input.dataset.selectGroup);
      const group = groups[groupIndex];
      const selectedInGroup = group.filter((c) => selectedIds.has(c.id)).length;
      input.checked = selectedInGroup === group.length;
      input.indeterminate = selectedInGroup > 0 && selectedInGroup < group.length;
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('change', () => {
        if (input.checked) group.forEach((c) => selectedIds.add(c.id));
        else group.forEach((c) => selectedIds.delete(c.id));
        renderCustomerListOnly();
        renderSelectionFooter();
      });
    });

    listEl.querySelectorAll('[data-toggle-group]').forEach((el) => {
      el.addEventListener('click', () => {
        const groupIndex = Number(el.dataset.toggleGroup);
        if (collapsedGroups.has(groupIndex)) collapsedGroups.delete(groupIndex);
        else collapsedGroups.add(groupIndex);
        renderCustomerListOnly();
      });
    });

    listEl.querySelectorAll('[data-customer-id]').forEach((input) => {
      input.addEventListener('change', () => {
        const id = Number(input.dataset.customerId);
        if (input.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        renderCustomerListOnly();
        renderSelectionFooter();
      });
    });
  }

  /**
   * Sticky footer beneath the customer list - same spot the Cart panel
   * puts "Complete Order" on the New Order page. Shows the running
   * selection total and is the one place "Send All" / "New Campaign"
   * live, right next to what's about to be sent to.
   */
  function renderSelectionFooter() {
    const footer = root.querySelector('#wa-selection-footer');
    if (!footer) return;

    const visible = allCustomers.filter((c) => !!c.phone);
    const groupCount = Math.ceil(selectedIds.size / GROUP_SIZE);
    const running = isRunning();
    const canStart = connectionStatus === 'READY' && selectedIds.size > 0 && !running && messageTemplate.trim().length > 0;

    footer.innerHTML = `
      <div class="mb-3 flex items-center justify-between text-xs">
        <span class="font-medium text-ink-secondary">
          ${selectedIds.size} selected${selectedIds.size > 0 ? ` &middot; ${groupCount} group${groupCount === 1 ? '' : 's'} of ${GROUP_SIZE}` : ''}
        </span>
        <span>
          ${
            selectedIds.size > 0
              ? `<button type="button" id="wa-select-all" class="mr-2 text-accent hover:underline">Select all ${visible.length}</button><button type="button" id="wa-clear-selection" class="text-accent hover:underline">Clear</button>`
              : `<button type="button" id="wa-select-all" class="text-accent hover:underline">Select all ${visible.length}</button>`
          }
        </span>
      </div>
      <div class="flex items-center gap-2">
        <button type="button" id="wa-start-btn"
          class="ripple-host flex-1 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white shadow-card transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-border-strong disabled:text-ink-muted">
          ${running ? 'Sending...' : `Send All (${selectedIds.size || 0})`}
        </button>
        <button type="button" id="wa-new-campaign-btn" title="Clear this session and start a fresh one"
          class="ripple-host rounded-xl border border-border px-3.5 py-3 text-xs font-medium text-ink-secondary hover:border-accent/30 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40">
          New
        </button>
      </div>
      ${connectionStatus !== 'READY' ? `<p class="mt-2 text-center text-[11px] text-ink-muted">Connect WhatsApp above to enable sending.</p>` : ''}
    `;

    const startBtn = footer.querySelector('#wa-start-btn');
    startBtn.disabled = !canStart;
    attachRipple(startBtn);
    startBtn.addEventListener('click', startCampaign);

    const newCampaignBtn = footer.querySelector('#wa-new-campaign-btn');
    newCampaignBtn.disabled = running;
    attachRipple(newCampaignBtn);
    newCampaignBtn.addEventListener('click', startNewCampaign);

    const selectAllBtn = footer.querySelector('#wa-select-all');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        visible.forEach((c) => selectedIds.add(c.id));
        renderCustomerListOnly();
        renderSelectionFooter();
      });
    }
    const clearBtn = footer.querySelector('#wa-clear-selection');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        selectedIds.clear();
        renderCustomerListOnly();
        renderSelectionFooter();
      });
    }
  }

  // =================================================================
  // Message + image card (quick-insert name + saved templates)
  // =================================================================
  function selectedCustomers() {
    return allCustomers.filter((c) => selectedIds.has(c.id));
  }

  /** Reads whatever image is currently active as a data URL, so it can
   *  be handed to the main process to save as a new template's image. */
  function getCurrentImageAsDataUrl() {
    return new Promise((resolve) => {
      if (dealImageFile) {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(dealImageFile);
        return;
      }
      if (dealImagePreviewUrl && dealImagePreviewUrl.startsWith('data:')) {
        resolve(dealImagePreviewUrl);
        return;
      }
      resolve(null);
    });
  }

  async function loadTemplates() {
    try {
      templates = await posApi.whatsapp.templates.list();
    } catch (err) {
      toaster.error(`Could not load saved templates: ${err.message}`);
      templates = [];
    }
    renderMessageCard();
  }

  async function applyTemplate(template) {
    selectedTemplateId = template.id;
    messageTemplate = template.message;
    dealImageFile = null;
    if (dealImagePreviewUrl && dealImagePreviewUrl.startsWith('blob:')) URL.revokeObjectURL(dealImagePreviewUrl);
    dealImagePath = null;
    dealImageRelativePath = null;
    dealImagePreviewUrl = null;

    if (template.image_path) {
      try {
        dealImagePreviewUrl = await posApi.whatsapp.getImage(template.image_path);
        dealImageRelativePath = template.image_path;
      } catch (err) {
        toaster.error(`Could not load this template's image: ${err.message}`);
      }
    }
    renderMessageCard();
    renderSelectionFooter();
  }

  async function deleteTemplate(id, name) {
    if (!window.confirm(`Delete the "${name}" template? This cannot be undone.`)) return;
    try {
      await posApi.whatsapp.templates.remove(id);
      if (selectedTemplateId === id) selectedTemplateId = null;
      toaster.success('Template deleted.');
      await loadTemplates();
    } catch (err) {
      toaster.error(err.message);
    }
  }

  function renderMessageCard() {
    const container = root.querySelector('#message-card');
    const previewName = selectedCustomers()[0]?.name || 'Ali';
    const hasImage = !!dealImagePreviewUrl;

    const templateChips =
      templates.length === 0
        ? `<p class="text-[11px] text-ink-muted">No saved templates yet - write a deal below and tap "Save as Template" so you never have to retype it.</p>`
        : `<div class="flex flex-wrap gap-1.5">
            ${templates
              .map(
                (t) => `
              <span class="group inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                selectedTemplateId === t.id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-ink-secondary hover:border-accent/30 hover:text-accent'
              }">
                <button type="button" data-load-template="${t.id}" class="ripple-host">${t.name}</button>
                <button type="button" data-delete-template="${t.id}" data-template-name="${t.name}" class="text-ink-muted opacity-60 hover:text-[#DC2626] hover:opacity-100" title="Delete template">&times;</button>
              </span>`
              )
              .join('')}
          </div>`;

    container.innerHTML = card(
      'Deal Message',
      `
      <div class="mb-3">
        <p class="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-muted">Saved deals</p>
        ${templateChips}
      </div>

      <div class="mb-4 flex items-center gap-3">
        <div id="wa-image-preview" class="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-surface-raised text-ink-muted">
          ${hasImage ? `<img src="${dealImagePreviewUrl}" alt="" class="h-full w-full object-cover" />` : `<span class="h-6 w-6">${iconMarkup('image')}</span>`}
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="ripple-host w-fit cursor-pointer rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">
            Choose deal image
            <input type="file" id="wa-image-input" accept="image/*" class="hidden" />
          </label>
          ${hasImage ? `<button type="button" id="wa-remove-image" class="w-fit text-xs text-ink-muted hover:text-accent">Remove image</button>` : ''}
        </div>
      </div>

      <div class="mb-2 flex items-center justify-between">
        <span class="text-sm font-medium text-ink-secondary">Message</span>
        <button type="button" id="wa-insert-name-btn" class="ripple-host inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">
          + Insert Customer Name
        </button>
      </div>
      <label class="flex flex-col gap-1.5 text-sm">
        <textarea id="wa-message-input" rows="4" placeholder="Type your deal here, or tap 'Insert Customer Name' to add it automatically."
          class="rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20">${messageTemplate}</textarea>
      </label>

      <div class="mt-3 rounded-xl bg-surface-raised p-3">
        <p class="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">Preview (for ${previewName})</p>
        <p id="wa-preview-text" class="whitespace-pre-wrap text-sm text-ink">${personalizeMessage(messageTemplate, previewName)}</p>
      </div>

      <div class="mt-3">
        ${
          showSaveTemplateForm
            ? `<div class="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-border bg-surface-raised p-2.5">
                <input id="wa-template-name-input" type="text" placeholder="Name this deal, e.g. Friday Deal"
                  class="min-w-0 flex-1 rounded-lg border border-border px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
                <button type="button" id="wa-save-template-confirm" class="ripple-host rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent-hover" ${savingTemplate ? 'disabled' : ''}>
                  ${savingTemplate ? 'Saving...' : 'Save'}
                </button>
                <button type="button" id="wa-save-template-cancel" class="ripple-host rounded-lg px-3 py-2 text-xs font-medium text-ink-secondary hover:text-ink">Cancel</button>
              </div>`
            : `<button type="button" id="wa-save-template-btn" class="ripple-host w-full rounded-xl border border-dashed border-border px-4 py-2 text-xs font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">
                Save this message as a template
              </button>`
        }
      </div>
      `,
      'send'
    );

    container.querySelectorAll('[data-load-template]').forEach((btn) => {
      attachRipple(btn);
      btn.addEventListener('click', () => {
        const template = templates.find((t) => t.id === Number(btn.dataset.loadTemplate));
        if (template) applyTemplate(template);
      });
    });
    container.querySelectorAll('[data-delete-template]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTemplate(Number(btn.dataset.deleteTemplate), btn.dataset.templateName);
      });
    });

    const imageInput = container.querySelector('#wa-image-input');
    imageInput.addEventListener('change', async () => {
      const file = imageInput.files?.[0];
      if (!file) return;
      const resolvedPath = posApi.files.getPathForFile(file);
      if (!resolvedPath) {
        toaster.error('Could not read that file\'s location on disk. Try picking it again.');
        return;
      }
      dealImageFile = file;
      dealImagePath = resolvedPath;
      dealImageRelativePath = null;
      selectedTemplateId = null; // a fresh image means we're no longer exactly "the saved template"
      if (dealImagePreviewUrl && dealImagePreviewUrl.startsWith('blob:')) URL.revokeObjectURL(dealImagePreviewUrl);
      dealImagePreviewUrl = URL.createObjectURL(file);
      renderMessageCard();
    });

    const removeImageBtn = container.querySelector('#wa-remove-image');
    if (removeImageBtn) {
      removeImageBtn.addEventListener('click', () => {
        dealImagePath = null;
        dealImageRelativePath = null;
        dealImageFile = null;
        if (dealImagePreviewUrl && dealImagePreviewUrl.startsWith('blob:')) URL.revokeObjectURL(dealImagePreviewUrl);
        dealImagePreviewUrl = null;
        renderMessageCard();
      });
    }

    const messageInput = container.querySelector('#wa-message-input');
    const previewText = container.querySelector('#wa-preview-text');
    function syncAfterMessageEdit() {
      previewText.textContent = personalizeMessage(messageTemplate, selectedCustomers()[0]?.name || 'Ali');
      renderSelectionFooter();
    }
    messageInput.addEventListener('input', () => {
      messageTemplate = messageInput.value;
      syncAfterMessageEdit();
    });

    // "+ Insert Customer Name" - inserts {name} at the cursor position
    // instead of asking a non-technical admin to type/remember it.
    const insertNameBtn = container.querySelector('#wa-insert-name-btn');
    insertNameBtn.addEventListener('click', () => {
      const el = messageInput;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = `${el.value.slice(0, start)}{name}${el.value.slice(end)}`;
      messageTemplate = next;
      el.value = next;
      el.focus();
      const cursor = start + '{name}'.length;
      el.setSelectionRange(cursor, cursor);
      syncAfterMessageEdit();
    });

    // Save as Template flow
    const saveBtn = container.querySelector('#wa-save-template-btn');
    if (saveBtn) {
      attachRipple(saveBtn);
      saveBtn.addEventListener('click', () => {
        if (!messageTemplate.trim()) {
          toaster.error('Write the deal message first.');
          return;
        }
        showSaveTemplateForm = true;
        renderMessageCard();
        root.querySelector('#wa-template-name-input')?.focus();
      });
    }
    const cancelSaveBtn = container.querySelector('#wa-save-template-cancel');
    if (cancelSaveBtn) {
      cancelSaveBtn.addEventListener('click', () => {
        showSaveTemplateForm = false;
        renderMessageCard();
      });
    }
    const confirmSaveBtn = container.querySelector('#wa-save-template-confirm');
    if (confirmSaveBtn) {
      attachRipple(confirmSaveBtn);
      confirmSaveBtn.addEventListener('click', async () => {
        const nameInput = root.querySelector('#wa-template-name-input');
        const name = nameInput?.value.trim();
        if (!name) {
          toaster.error('Give this template a short name first.');
          return;
        }
        savingTemplate = true;
        renderMessageCard();
        try {
          const imageDataUrl = await getCurrentImageAsDataUrl();
          const created = await posApi.whatsapp.templates.create({ name, message: messageTemplate, imageDataUrl });
          toaster.success(`Saved "${name}" - it'll show up above next time.`);
          showSaveTemplateForm = false;
          savingTemplate = false;
          selectedTemplateId = created.id;
          await loadTemplates();
        } catch (err) {
          savingTemplate = false;
          toaster.error(err.message);
          renderMessageCard();
        }
      });
    }
  }

  // =================================================================
  // Progress card - group timeline + sent/remaining/failed lists
  // =================================================================
  function isRunning() {
    return session?.runState === 'running';
  }

  function flatContacts() {
    if (!session) return [];
    return session.groups.flatMap((group, groupIndex) => group.map((c) => ({ ...c, groupIndex })));
  }

  function countsByStatus() {
    const flat = flatContacts();
    const sent = flat.filter((c) => c.status === 'sent').length;
    const failed = flat.filter((c) => c.status === 'failed').length;
    const remaining = flat.length - sent - failed;
    return { sent, failed, remaining, total: flat.length };
  }

  function ensureCountdownTimer() {
    if (countdownTimer) return;
    countdownTimer = setInterval(() => {
      if (!session?.nextGroupAt) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        return;
      }
      updateCountdownDisplay();
    }, 1000);
  }

  /**
   * Updates just the countdown text + its mini progress bar during an
   * inter-group wait - two direct DOM writes instead of a full
   * renderProgressCard() rebuild every second. With a large campaign
   * (many groups, hundreds of contacts in the list) a full rebuild
   * means recreating hundreds of DOM nodes every single tick for the
   * entire 6-15 minute wait; this keeps that tick to the two nodes
   * that actually change. Real data changes (a send completing, a
   * group starting) still go through the normal full render below.
   */
  function updateCountdownDisplay() {
    const label = root.querySelector('[data-countdown-label]');
    const bar = root.querySelector('[data-countdown-bar]');
    if (!label || !bar || !session?.nextGroupAt) return;
    label.textContent = `Next group in ${formatCountdown(new Date(session.nextGroupAt).getTime() - Date.now())}`;
    bar.style.width = `${waitElapsedPercent()}%`;
  }

  function renderTimeline() {
    if (!session || session.groups.length <= 1) return '';
    return `
      <div class="mb-4 flex flex-col gap-2">
        ${session.groups
          .map((group, idx) => {
            const sent = group.filter((c) => c.status === 'sent').length;
            const failed = group.filter((c) => c.status === 'failed').length;
            const done = sent + failed;
            const sendingContact = group.find((c) => c.status === 'sending');
            const isCurrent = idx === session.currentGroupIndex && (isRunning() || session.nextGroupAt);
            const isWaiting = isCurrent && session.nextGroupAt;
            const isSendingNow = isCurrent && !!sendingContact;
            const isDoneGroup = done === group.length;
            const percent = group.length ? Math.round((done / group.length) * 100) : 0;

            let statusLabel;
            let barTone;
            if (isWaiting) {
              statusLabel = `<span class="text-accent" data-countdown-label>Next group in ${formatCountdown(new Date(session.nextGroupAt).getTime() - Date.now())}</span>`;
              barTone = 'bg-accent';
            } else if (isSendingNow) {
              statusLabel = `<span class="inline-flex items-center gap-1.5 text-accent"><span class="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent"></span>Sending to ${sendingContact.name}...</span>`;
              barTone = 'bg-accent';
            } else if (isDoneGroup) {
              statusLabel =
                failed > 0
                  ? `<span class="text-[#DC2626]">Done - ${failed} failed</span>`
                  : `<span class="text-[#16A34A]">Done</span>`;
              barTone = failed > 0 ? 'bg-[#DC2626]' : 'bg-[#16A34A]';
            } else if (done > 0) {
              statusLabel = `<span class="text-ink-secondary">In progress</span>`;
              barTone = 'bg-accent';
            } else {
              statusLabel = `<span class="text-ink-muted">Waiting to start</span>`;
              barTone = 'bg-border-strong';
            }

            return `
            <div class="rounded-xl border ${isCurrent ? 'border-accent/30 bg-accent/5' : 'border-border'} px-3 py-2">
              <div class="mb-1.5 flex items-center justify-between gap-2 text-xs">
                <span class="font-semibold text-ink">Group ${idx + 1}</span>
                <span class="font-nums text-ink-muted">${done}/${group.length}</span>
              </div>
              <div class="mb-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
                <div class="h-full rounded-full ${barTone} transition-all" style="width: ${percent}%"></div>
              </div>
              <p class="text-[11px] font-medium">${statusLabel}</p>
              ${
                isWaiting
                  ? `<div class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-accent/10">
                      <div class="h-full rounded-full bg-accent/50" data-countdown-bar style="width: ${waitElapsedPercent()}%"></div>
                    </div>`
                  : ''
              }
            </div>`;
          })
          .join('')}
      </div>`;
  }

  /** How far through the current inter-group wait we are, 0-100 - purely
   *  a visual "something is happening" cue, not an exact countdown. */
  function waitElapsedPercent() {
    if (!session?.nextGroupAt) return 0;
    if (!session._waitStartedAt) session._waitStartedAt = Date.now();
    const total = new Date(session.nextGroupAt).getTime() - session._waitStartedAt;
    const elapsed = Date.now() - session._waitStartedAt;
    if (total <= 0) return 100;
    return Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
  }

  function renderProgressCard() {
    const container = root.querySelector('#progress-card');
    if (!session) {
      container.innerHTML = `
        <div class="flex h-full flex-col items-center justify-center gap-2 text-center">
          <span class="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-raised text-ink-muted">${iconMarkup('send')}</span>
          <p class="text-sm font-medium text-ink">No campaign running</p>
          <p class="max-w-[220px] text-xs text-ink-muted">Pick customers on the right and hit "Send All" - progress shows up here.</p>
        </div>`;
      return;
    }

    const { sent, failed, remaining, total } = countsByStatus();
    const percent = total ? Math.round(((sent + failed) / total) * 100) : 0;
    const running = isRunning();
    const runPill = RUN_STATE_PILL[session.runState] || RUN_STATE_PILL.completed;
    if (session.nextGroupAt) ensureCountdownTimer();

    const filters = [
      { id: 'all', label: 'All', count: total },
      { id: 'remaining', label: 'Remaining', count: remaining },
      { id: 'sent', label: 'Sent', count: sent },
      { id: 'failed', label: 'Failed', count: failed },
    ];

    const rows = flatContacts().filter((c) => {
      if (progressFilter === 'sent') return c.status === 'sent';
      if (progressFilter === 'failed') return c.status === 'failed';
      if (progressFilter === 'remaining') return c.status === 'pending' || c.status === 'sending';
      return true;
    });

    container.innerHTML = `
      <header class="mb-4 flex items-center justify-between gap-2">
        <h2 class="font-display text-sm font-bold text-ink">Sending Progress</h2>
        <span class="rounded-full px-2.5 py-1 text-[11px] font-medium ${runPill.tone}">${runPill.label}</span>
      </header>
      <div class="mb-3 flex flex-wrap items-center justify-end gap-2">
        ${
          running
            ? `<button type="button" id="wa-stop-btn" class="ripple-host rounded-lg border border-[#DC2626]/30 px-3 py-1.5 text-xs font-medium text-[#DC2626] hover:bg-[#DC2626]/10">Stop sending</button>`
            : session.runState === 'stopped' && remaining > 0
            ? `<button type="button" id="wa-resume-btn" class="ripple-host rounded-lg border border-accent/30 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10">Resume sending</button>`
            : ''
        }
        ${
          !running && failed > 0
            ? `<button type="button" id="wa-retry-btn" class="ripple-host rounded-lg border border-accent/30 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10">Retry ${failed} failed</button>`
            : ''
        }
      </div>
      <div class="mb-4 grid grid-cols-4 gap-2">
        <div class="rounded-xl bg-[#16A34A]/10 px-2 py-2.5 text-center">
          <p class="font-nums text-xl font-bold text-[#16A34A]">${sent}</p>
          <p class="text-[10px] font-medium uppercase tracking-wide text-[#16A34A]/80">Sent</p>
        </div>
        <div class="rounded-xl bg-[#DC2626]/10 px-2 py-2.5 text-center">
          <p class="font-nums text-xl font-bold text-[#DC2626]">${failed}</p>
          <p class="text-[10px] font-medium uppercase tracking-wide text-[#DC2626]/80">Failed</p>
        </div>
        <div class="rounded-xl bg-surface-raised px-2 py-2.5 text-center">
          <p class="font-nums text-xl font-bold text-ink-secondary">${remaining}</p>
          <p class="text-[10px] font-medium uppercase tracking-wide text-ink-muted">Remaining</p>
        </div>
        <div class="rounded-xl bg-accent/10 px-2 py-2.5 text-center">
          <p class="font-nums text-xl font-bold text-accent">${total}</p>
          <p class="text-[10px] font-medium uppercase tracking-wide text-accent/80">Total</p>
        </div>
      </div>
      <div class="mb-4 h-2 w-full overflow-hidden rounded-full bg-surface-raised">
        <div class="h-full rounded-full ${failed > 0 && !running ? 'bg-[#DC2626]' : 'bg-accent'} transition-all" style="width: ${percent}%"></div>
      </div>
      ${renderTimeline()}
      <div class="mb-2 flex flex-wrap gap-1.5">
        ${filters
          .map(
            (f) => `
          <button type="button" data-progress-filter="${f.id}"
            class="ripple-host rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              progressFilter === f.id ? 'bg-accent text-white' : 'border border-border text-ink-secondary hover:border-accent/30 hover:text-accent'
            }">
            ${f.label} (${f.count})
          </button>`
          )
          .join('')}
      </div>
      <div class="flex max-h-[50vh] flex-col divide-y divide-border overflow-y-auto rounded-xl border border-border">
        ${
          rows.length === 0
            ? `<p class="px-4 py-6 text-center text-sm text-ink-muted">Nothing in this list.</p>`
            : rows
                .map((r) => {
                  const icon =
                    r.status === 'sent'
                      ? `<span class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#16A34A]/10 text-[#16A34A]"><span class="h-3 w-3">${iconMarkup('check')}</span></span>`
                      : r.status === 'failed'
                      ? `<span class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#DC2626]/10 text-[#DC2626]"><span class="h-3 w-3">${iconMarkup('close')}</span></span>`
                      : r.status === 'sending'
                      ? `<span class="flex h-5 w-5 flex-shrink-0 items-center justify-center"><span class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent"></span></span>`
                      : `<span class="flex h-5 w-5 flex-shrink-0 items-center justify-center text-ink-muted"><span class="h-3 w-3">${iconMarkup('clock')}</span></span>`;
                  return `
              <div class="flex items-center gap-2.5 px-4 py-2.5 text-sm" title="${r.error || ''}">
                ${icon}
                <span class="min-w-0 flex-1 truncate text-ink">${r.name} <span class="text-[11px] text-ink-muted">&middot; Group ${r.groupIndex + 1}</span></span>
              </div>`;
                })
                .join('')
        }
      </div>
    `;

    const stopBtn = container.querySelector('#wa-stop-btn');
    if (stopBtn) {
      attachRipple(stopBtn);
      stopBtn.addEventListener('click', async () => {
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping...';
        try {
          await posApi.whatsapp.stopCampaign();
        } catch (err) {
          toaster.error(err.message);
        }
      });
    }
    const resumeBtn = container.querySelector('#wa-resume-btn');
    if (resumeBtn) {
      attachRipple(resumeBtn);
      resumeBtn.addEventListener('click', async () => {
        if (connectionStatus !== 'READY') {
          toaster.error('Connect WhatsApp first.');
          return;
        }
        resumeBtn.disabled = true;
        resumeBtn.textContent = 'Resuming...';
        try {
          await posApi.whatsapp.resumeCampaign();
          await refreshSession();
        } catch (err) {
          toaster.error(err.message);
          renderProgressCard();
        }
      });
    }
    const retryBtn = container.querySelector('#wa-retry-btn');
    if (retryBtn) {
      attachRipple(retryBtn);
      retryBtn.addEventListener('click', async () => {
        if (connectionStatus !== 'READY') {
          toaster.error('Connect WhatsApp first.');
          return;
        }
        retryBtn.disabled = true;
        retryBtn.textContent = 'Retrying...';
        try {
          await posApi.whatsapp.retryFailed();
          progressFilter = 'all';
          await refreshSession();
        } catch (err) {
          toaster.error(err.message);
          renderProgressCard();
        }
      });
    }
    container.querySelectorAll('[data-progress-filter]').forEach((btn) => {
      attachRipple(btn);
      btn.addEventListener('click', () => {
        progressFilter = btn.dataset.progressFilter;
        renderProgressCard();
      });
    });
  }

  // =================================================================
  // Campaign lifecycle
  // =================================================================
  async function refreshSession() {
    try {
      session = await posApi.whatsapp.getCampaignState();
    } catch (err) {
      toaster.error(`Could not load sending status: ${err.message}`);
    }
    renderMessageCard();
    renderProgressCard();
    renderSelectionFooter();
  }

  async function startCampaign() {
    const contacts = selectedCustomers().map((c) => ({ id: c.id, name: c.name, phone: c.phone }));
    if (contacts.length === 0) {
      toaster.error('Select at least one customer.');
      return;
    }
    if (!messageTemplate.trim()) {
      toaster.error('Write the deal message first.');
      return;
    }
    if (session && session.runState !== 'completed' && countsByStatus().remaining > 0) {
      if (!window.confirm('There is an unfinished session (paused/failed items). Starting a new "Send All" will replace it. Continue?')) {
        return;
      }
    }

    try {
      await posApi.whatsapp.startCampaign({
        contacts,
        message: messageTemplate,
        imagePath: dealImagePath,
        imageRelativePath: dealImagePath ? null : dealImageRelativePath,
      });
      progressFilter = 'all';
      await refreshSession();
    } catch (err) {
      toaster.error(err.message);
    }
  }

  async function startNewCampaign() {
    if (isRunning()) {
      toaster.error('Stop the current send before starting a new campaign.');
      return;
    }
    if (session && !window.confirm('This clears the current sent/remaining/failed list. Continue?')) return;
    try {
      await posApi.whatsapp.newCampaign();
    } catch (err) {
      toaster.error(err.message);
      return;
    }
    session = null;
    progressFilter = 'all';
    selectedIds.clear();
    messageTemplate = "our {name}, don't miss today's special deal! Reply to this message to order.";
    selectedTemplateId = null;
    dealImageFile = null;
    if (dealImagePreviewUrl && dealImagePreviewUrl.startsWith('blob:')) URL.revokeObjectURL(dealImagePreviewUrl);
    dealImagePath = null;
    dealImageRelativePath = null;
    dealImagePreviewUrl = null;
    renderCustomerListOnly();
    renderMessageCard();
    renderProgressCard();
    renderSelectionFooter();
    toaster.success('Ready for a new campaign.');
  }

  // =================================================================
  // Live event stream from the main process
  // =================================================================
  function handleWhatsappEvent(payload) {
    switch (payload.type) {
      case 'status':
        connectionStatus = payload.status;
        qrDataUrl = payload.qr ?? null;
        statusMessage = payload.message ?? statusMessage;
        renderConnectionCard();
        renderMessageCard();
        renderSelectionFooter();
        break;
      case 'campaign-start':
        refreshSession();
        break;
      case 'contact-status': {
        if (session?.groups?.[payload.groupIndex]) {
          const contact = session.groups[payload.groupIndex].find((c) => c.id === payload.contactId);
          if (contact) {
            contact.status = payload.status;
            contact.error = payload.error || null;
          }
        }
        renderProgressCard();
        break;
      }
      case 'group-wait':
        if (session) {
          session.nextGroupAt = payload.resumeAt;
          session.currentGroupIndex = payload.toGroupIndex;
          session._waitStartedAt = Date.now();
        }
        renderProgressCard();
        break;
      case 'group-start':
        if (session) {
          session.currentGroupIndex = payload.groupIndex;
          session._waitStartedAt = null;
        }
        renderProgressCard();
        break;
      case 'group-done':
        if (session) session.currentGroupIndex = payload.groupIndex;
        renderProgressCard();
        break;
      case 'campaign-done':
        toaster.success(`Send finished - ${payload.totalSent} sent, ${payload.totalFailed} failed.`);
        refreshSession();
        break;
      case 'campaign-stopped':
        toaster.error('Sending stopped - the rest stays queued as "Remaining", resume anytime.');
        refreshSession();
        break;
      case 'campaign-error':
        toaster.error(payload.message || 'The campaign stopped unexpectedly.');
        refreshSession();
        break;
      case 'campaign-cleared':
        session = null;
        renderMessageCard();
        renderProgressCard();
        renderSelectionFooter();
        break;
      default:
        break;
    }
  }

  async function boot() {
    renderConnectionCard();
    renderFilterRow();
    renderMessageCard();
    renderProgressCard();
    renderSelectionFooter();
    await Promise.all([loadCustomers(), loadTemplates()]);

    unsubscribeEvents = posApi.whatsapp.onEvent(handleWhatsappEvent);

    try {
      const status = await posApi.whatsapp.getStatus();
      connectionStatus = status.status;
      qrDataUrl = status.qr;
      statusMessage = status.message;
      renderConnectionCard();
    } catch (err) {
      toaster.error(`Could not reach WhatsApp service: ${err.message}`);
    }

    // Restores sent/remaining/failed exactly as they were even if the
    // app was closed and reopened - see campaignStore.js. Only "New
    // Campaign" ever clears this.
    await refreshSession();
  }

  boot();

  root._cleanup = () => {
    if (typeof unsubscribeEvents === 'function') unsubscribeEvents();
    if (countdownTimer) clearInterval(countdownTimer);
    if (dealImagePreviewUrl && dealImagePreviewUrl.startsWith('blob:')) URL.revokeObjectURL(dealImagePreviewUrl);
  };

  return root;
}
