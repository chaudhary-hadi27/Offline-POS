'use strict';

import { posApi } from '../shell/posApi.js';
import { iconMarkup } from '../shell/icons.js';
import { attachRipple, attachRippleAll } from '../shell/ripple.js';
import { toaster } from '../shell/toast.js';
import { patternSvgMarkup, wirePatternEvents, PATTERN_MIN_LENGTH } from '../shell/patternLock.js';
import { getBusinessDayStart, formatLocal } from '../shell/businessDay.js';

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

/** ON/OFF pill switch: green + knob right when on, red + knob left when off. */
function toggleClasses(isOn) {
  return {
    track: `ripple-host relative h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200 ease-in-out ${isOn ? 'bg-[#16A34A]' : 'bg-[#DC2626]'}`,
    knob: `absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ease-in-out ${isOn ? 'translate-x-[20px]' : 'translate-x-0'}`,
  };
}

export function renderSettings() {
  const root = document.createElement('div');
  root.className = 'flex h-full w-full flex-col overflow-y-auto bg-surface px-8 py-8 md:px-12';
  root.innerHTML = `<div class="flex h-full w-full items-center justify-center text-sm text-ink-muted">Loading...</div>`;

  async function boot() {
    const [settings, lockConfigured, lockType] = await Promise.all([
      posApi.settings.getAll(),
      posApi.security.isConfigured(),
      posApi.security.getLockType(),
    ]);

    root.innerHTML = `
      <header class="mb-6">
        <h1 class="font-display text-xl font-bold text-ink">Settings</h1>
        <p class="text-sm text-ink-secondary">Configuration</p>
      </header>
      <div class="grid max-w-3xl grid-cols-1 gap-5">
        <div id="schedule-card"></div>
        <div id="info-card"></div>
        <div id="lock-card"></div>
        <div id="danger-card"></div>
      </div>
    `;

    renderScheduleCard(settings);
    renderInfoCard(settings);
    renderLockCard(lockConfigured, lockType);
    renderDangerZoneCard(settings);
  }

  // ---------------- Scheduled Business Hours (auto Day Start / Close) ----------------
  function renderScheduleCard(settings) {
    const container = root.querySelector('#schedule-card');
    let isEnabled = settings.auto_day_start_enabled === '1';

    container.innerHTML = card(
      'Scheduled Business Hours',
      `
      <p class="mb-4 text-sm text-ink-secondary">Decides what counts as "Today" in Order History, and automatically opens/closes the shift for the day - no manual register close needed.</p>
      <div class="mb-4 flex items-center gap-3">
        <button type="button" id="auto-start-toggle" class="${toggleClasses(isEnabled).track}">
          <span class="${toggleClasses(isEnabled).knob}"></span>
        </button>
        <span id="auto-start-label" class="text-sm text-ink-secondary">${isEnabled ? 'Auto Day Start is on' : 'Auto Day Start is off'}</span>
      </div>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-xs text-ink-secondary">
          Day starts at
          <input type="time" name="day_start_time" value="${settings.day_start_time || '15:00'}"
            class="rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-secondary">
          Day ends at
          <input type="time" name="day_end_time" value="${settings.day_end_time || '03:00'}"
            class="rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
        </label>
      </div>
      <button type="button" id="save-schedule-btn" class="ripple-host mt-4 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover">
        Save Schedule
      </button>
      `,
      'clock'
    );

    const toggleBtn = container.querySelector('#auto-start-toggle');
    const toggleLabel = container.querySelector('#auto-start-label');
    attachRipple(toggleBtn);
    toggleBtn.addEventListener('click', () => {
      isEnabled = !isEnabled;
      const t = toggleClasses(isEnabled);
      toggleBtn.className = t.track;
      toggleBtn.querySelector('span').className = t.knob;
      toggleLabel.textContent = isEnabled ? 'Auto Day Start is on' : 'Auto Day Start is off';
    });

    const saveBtn = container.querySelector('#save-schedule-btn');
    attachRipple(saveBtn);
    saveBtn.addEventListener('click', async () => {
      try {
        await posApi.settings.set({
          auto_day_start_enabled: isEnabled ? '1' : '0',
          day_start_time: container.querySelector('[name="day_start_time"]').value,
          day_end_time: container.querySelector('[name="day_end_time"]').value,
        });
        toaster.success('Schedule saved.');
      } catch (err) {
        toaster.error(err.message);
      }
    });
  }

  // ---------------- Restaurant info / tax / printer ----------------
  function renderInfoCard(settings) {
    const container = root.querySelector('#info-card');

    function field(name, label, value, type = 'text', placeholder = '', full = false) {
      // Number fields (tax rate, delivery charge) start at a real "0"
      // default, not a placeholder - without select-on-focus, typing
      // a new value just appends after that 0 (e.g. "0" -> "05") until
      // the cashier manually deletes it first. Selecting the existing
      // value on focus means the first keystroke replaces it outright,
      // same as any POS numeric-entry field should behave.
      const selectOnFocus = type === 'number' ? ' onfocus="this.select()"' : '';
      return `
        <label class="flex flex-col gap-1.5 text-sm ${full ? 'sm:col-span-2' : ''}">
          <span class="font-medium text-ink-secondary">${label}</span>
          <input name="${name}" type="${type}" value="${value ?? ''}" placeholder="${placeholder}"${selectOnFocus}
            class="rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
        </label>`;
    }

    container.innerHTML = card(
      'Restaurant &amp; Receipt',
      `
      <form id="info-form" class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        ${field('restaurant_name', 'Restaurant name', settings.restaurant_name)}
        ${field('default_tax_rate', 'Default tax rate (%)', settings.default_tax_rate, 'number')}
        ${field('delivery_charge', 'Delivery charge (Rs.)', settings.delivery_charge, 'number')}
        <div class="flex flex-col gap-1.5 text-sm sm:col-span-2">
          <span class="font-medium text-ink-secondary">Windows printer</span>
          <div class="flex gap-2">
            <input name="printer_port" list="printer-suggestions" value="${settings.printer_port ?? ''}"
              placeholder="Click Detect Printers, or type an exact printer name"
              class="flex-1 rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
            <button type="button" id="detect-printers-btn"
              class="ripple-host whitespace-nowrap rounded-xl border border-border px-3.5 py-2.5 text-sm font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">
              Detect Printers
            </button>
          </div>
          <datalist id="printer-suggestions"></datalist>
          <span id="printer-detect-status" class="text-[11px] text-ink-muted"></span>
        </div>
        ${field('receipt_width_mm', 'Receipt width override (mm) - leave blank to auto-detect', settings.receipt_width_mm, 'text', 'Auto-detected from printer')}
        <label class="flex flex-col gap-1.5 text-sm sm:col-span-2">
          <span class="font-medium text-ink-secondary">Receipt header</span>
          <textarea name="receipt_header" rows="2" placeholder="e.g.&#10;123 Main Street, Lahore&#10;021-111222333"
            class="rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20">${settings.receipt_header ?? ''}</textarea>
        </label>
        ${field('receipt_footer', 'Receipt footer', settings.receipt_footer, 'text', '', true)}
        <div class="sm:col-span-2">
          <button type="submit" class="ripple-host rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover">
            Save changes
          </button>
        </div>
      </form>
      `,
      'settings'
    );

    const form = container.querySelector('#info-form');
    attachRipple(form.querySelector('button[type="submit"]'));

    const detectBtn = form.querySelector('#detect-printers-btn');
    const printerInput = form.querySelector('[name="printer_port"]');
    const printerStatus = form.querySelector('#printer-detect-status');
    attachRipple(detectBtn);
    detectBtn.addEventListener('click', async () => {
      detectBtn.disabled = true;
      detectBtn.textContent = 'Detecting...';
      try {
        const printers = await posApi.printer.listPrinters();
        form.querySelector('#printer-suggestions').innerHTML = printers
          .map((p) => `<option value="${p.name}">${p.displayName}</option>`)
          .join('');
        if (printers.length === 0) {
          printerStatus.textContent = 'No printers found. Install your printer\'s Windows driver first, then try again.';
        } else {
          printerStatus.textContent = `Found ${printers.length} printer${printers.length === 1 ? '' : 's'} - pick one from the list.`;
          if (!printerInput.value) {
            printerInput.value = (printers.find((p) => p.isDefault) || printers[0]).name;
          }
        }
      } catch (err) {
        toaster.error(err.message);
      } finally {
        detectBtn.disabled = false;
        detectBtn.textContent = 'Detect Printers';
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        await posApi.settings.set(data);
        toaster.success('Settings saved.');
      } catch (err) {
        toaster.error(err.message);
      }
    });
  }

  // ---------------- Security lock setup ----------------
  function renderLockCard(configured, currentType) {
    const container = root.querySelector('#lock-card');
    container.innerHTML = card(
      'Security Lock',
      `
      <div class="mb-4 flex items-center justify-between rounded-xl bg-surface-raised px-4 py-3">
        <span class="text-sm text-ink-secondary">
          ${configured ? `Currently locked with a <span class="font-medium text-ink">${currentType}</span>.` : 'No lock is set. Secured modules are open to anyone.'}
        </span>
        ${configured ? `<button type="button" id="remove-lock-btn" class="ripple-host rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">Remove lock</button>` : ''}
      </div>
      <div id="lock-type-tabs" class="mb-4 grid max-w-xs grid-cols-3 gap-2"></div>
      <div id="lock-credential-input" class="max-w-xs"></div>
      <div id="lock-question-inputs" class="mt-3 flex max-w-xs flex-col gap-2.5"></div>
      <button type="button" id="save-lock-btn" class="ripple-host mt-4 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover">
        ${configured ? 'Update lock' : 'Set lock'}
      </button>
      `,
      'lock'
    );

    let selectedType = currentType || 'PIN';
    let capturedPattern = [];

    const tabsEl = container.querySelector('#lock-type-tabs');
    const credEl = container.querySelector('#lock-credential-input');
    const questionEl = container.querySelector('#lock-question-inputs');
    const saveBtn = container.querySelector('#save-lock-btn');

    function renderTabs() {
      tabsEl.innerHTML = ['PIN', 'PASSWORD', 'PATTERN']
        .map(
          (t) => `<button type="button" data-t="${t}" class="type-tab ripple-host rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${t === selectedType ? 'border-accent bg-accent/10 text-accent' : 'border-border text-ink-secondary'}">${t}</button>`
        )
        .join('');
      tabsEl.querySelectorAll('.type-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectedType = btn.dataset.t;
          renderTabs();
          renderCredential();
        });
      });
      attachRippleAll(tabsEl, '.type-tab');
    }

    function renderCredential() {
      if (selectedType === 'PATTERN') {
        capturedPattern = [];
        credEl.innerHTML = `
          <div class="flex justify-center">${patternSvgMarkup('settings-pattern-svg')}</div>
          <p class="mt-1 text-center text-xs text-ink-muted">Draw and release to capture</p>
        `;
        wirePatternEvents(credEl.querySelector('#settings-pattern-svg'), {
          onComplete: (path) => {
            capturedPattern = path;
            toaster.show('Pattern captured.', { duration: 1500 });
          },
          onError: (msg) => toaster.error(msg),
        });
      } else {
        credEl.innerHTML = `
          <input type="${selectedType === 'PIN' ? 'text' : 'password'}" inputmode="${selectedType === 'PIN' ? 'numeric' : 'text'}" name="credential"
            placeholder="${selectedType === 'PIN' ? '4-6 digit PIN' : 'New password'}"
            class="w-full rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
        `;
      }
    }

    questionEl.innerHTML = `
      <input type="text" name="question" placeholder="Security question (optional, recommended)"
        class="rounded-xl border border-border px-3.5 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
      <input type="text" name="answer" placeholder="Answer"
        class="rounded-xl border border-border px-3.5 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
    `;

    renderTabs();
    renderCredential();
    attachRipple(saveBtn);

    saveBtn.addEventListener('click', async () => {
      let credential;
      if (selectedType === 'PATTERN') {
        if (capturedPattern.length < PATTERN_MIN_LENGTH) {
          toaster.error(`Draw a pattern connecting at least ${PATTERN_MIN_LENGTH} dots first.`);
          return;
        }
        credential = capturedPattern.join('-');
      } else {
        credential = credEl.querySelector('[name="credential"]').value;
        if (selectedType === 'PIN' && !/^\d{4,6}$/.test(credential)) {
          toaster.error('PIN must be 4-6 digits.');
          return;
        }
        if (selectedType === 'PASSWORD' && credential.length < 4) {
          toaster.error('Password must be at least 4 characters.');
          return;
        }
      }
      const question = questionEl.querySelector('[name="question"]').value.trim() || null;
      const answer = questionEl.querySelector('[name="answer"]').value.trim() || null;

      try {
        await posApi.security.setLock({ lockType: selectedType, credential, securityQuestion: question, securityAnswer: answer });
        toaster.success('Lock saved.');
        renderLockCard(true, selectedType);
      } catch (err) {
        toaster.error(err.message);
      }
    });

    const removeBtn = container.querySelector('#remove-lock-btn');
    if (removeBtn) {
      attachRipple(removeBtn);
      removeBtn.addEventListener('click', async () => {
        try {
          await posApi.security.clearLock();
          toaster.success('Lock removed. Secured modules are now open.');
          renderLockCard(false, null);
        } catch (err) {
          toaster.error(err.message);
        }
      });
    }
  }

  // ---------------- Danger Zone: clear old orders from History & Reports ----------------
  // Order History and Reports & Analytics are both just different views over
  // the same orders/order_items data - Reports has no storage of its own,
  // every number there is computed live (see electron/database/repositories/
  // analytics.js). So there's only ever one thing to clear here; picking
  // "History", "Reports", or "Both" would all do the exact same thing, which
  // would be confusing dressed up as three different buttons. Instead this
  // is presented as one simple, honest tool with a plain explanation.
  //
  // This is a SOFT delete (orders.deleted_at gets stamped, see
  // deleteOrdersInRange() in orders.js) - the order rows themselves, and
  // any customer they belong to, are never removed from the database.
  // Only their visibility in History/Reports/a customer's order list
  // changes. Copy below is worded to say exactly that, not "permanently
  // erase", since nothing is actually erased anymore.
  function renderDangerZoneCard(settingsData) {
    const container = root.querySelector('#danger-card');
    const PRESETS = [
      { key: 'today', label: 'Today' },
      { key: 'week', label: 'Last 7 days' },
      { key: 'month', label: 'Last 30 days' },
      { key: 'all', label: 'All time' },
      { key: 'custom', label: 'Custom range' },
    ];

    let toolsOpen = false;
    let preset = 'today';
    let previewCount = null; // null = not checked yet
    let previewToken = 0;

    function computeRange() {
      if (preset === 'all') return { startDate: null, endDate: null };
      const now = new Date();
      const dayStart = getBusinessDayStart(now, settingsData.day_start_time);
      if (preset === 'today') return { startDate: formatLocal(dayStart), endDate: formatLocal(now) };
      if (preset === 'week') {
        const start = new Date(dayStart);
        start.setDate(start.getDate() - 6);
        return { startDate: formatLocal(start), endDate: formatLocal(now) };
      }
      if (preset === 'month') {
        const start = new Date(dayStart);
        start.setDate(start.getDate() - 29);
        return { startDate: formatLocal(start), endDate: formatLocal(now) };
      }
      // custom
      const startInput = container.querySelector('#danger-range-start');
      const endInput = container.querySelector('#danger-range-end');
      if (!startInput || !endInput || !startInput.value || !endInput.value) return null;
      return { startDate: `${startInput.value} 00:00:00`, endDate: `${endInput.value} 23:59:59` };
    }

    function labelFor(key) {
      return PRESETS.find((p) => p.key === key)?.label || '';
    }

    async function refreshPreview() {
      const range = computeRange();
      const countEl = container.querySelector('#danger-preview');
      const deleteBtn = container.querySelector('#danger-delete-btn');
      if (!countEl || !deleteBtn) return;
      if (!range) {
        previewCount = null;
        countEl.textContent = 'Pick a start and end date above.';
        deleteBtn.disabled = true;
        return;
      }
      const token = ++previewToken;
      countEl.textContent = 'Checking…';
      try {
        const count = await posApi.orders.dangerCount(range);
        if (token !== previewToken) return; // a newer filter change already superseded this check
        previewCount = count;
        countEl.textContent =
          count === 0
            ? `No orders in this period - nothing to clear.`
            : `This will remove ${count} order${count === 1 ? '' : 's'} (${labelFor(preset)}) from Order History and Reports & Analytics. Customer records and their data are never affected.`;
        deleteBtn.disabled = count === 0;
      } catch (err) {
        if (token !== previewToken) return;
        countEl.textContent = 'Could not check how many orders match. Try again.';
        deleteBtn.disabled = true;
      }
    }

    function draw() {
      const { track, knob } = toggleClasses(toolsOpen);
      container.innerHTML = card(
        'Danger Zone',
        `
        <div class="flex items-center justify-between gap-4 rounded-xl border border-[#DC2626]/30 bg-[#DC2626]/5 p-4">
          <div>
            <p class="text-sm font-medium text-ink">Clear old orders from History &amp; Reports</p>
            <p class="mt-1 text-xs text-ink-secondary">Off by default so this can't be triggered by accident. This removes orders from Order History and Reports &amp; Analytics only - customer records are never deleted.</p>
          </div>
          <button type="button" id="danger-toggle" class="${track}">
            <span class="${knob}"></span>
          </button>
        </div>
        <div id="danger-tools" class="search-collapse ${toolsOpen ? 'is-open' : ''}">
          <div class="pt-4">
            <p class="mb-2.5 text-xs font-medium text-ink-secondary">What period do you want to delete?</p>
            <div id="danger-preset-chips" class="flex flex-wrap gap-2"></div>
            <div id="danger-custom-range" class="mt-3 hidden flex-wrap items-center gap-2">
              <input type="date" id="danger-range-start" class="rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
              <span class="text-xs text-ink-muted">to</span>
              <input type="date" id="danger-range-end" class="rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
            </div>
            <p id="danger-preview" class="mt-3 text-xs font-medium text-ink-secondary">Checking…</p>
            <button type="button" id="danger-delete-btn" disabled
              class="ripple-host mt-3 rounded-xl bg-[#DC2626] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#B91C1C] disabled:cursor-not-allowed disabled:opacity-40">
              Clear from History &amp; Reports
            </button>
          </div>
        </div>
        `,
        'alertTriangle'
      );

      const toggleBtn = container.querySelector('#danger-toggle');
      attachRipple(toggleBtn);
      toggleBtn.addEventListener('click', () => {
        toolsOpen = !toolsOpen;
        const toolsEl = container.querySelector('#danger-tools');
        toolsEl.classList.toggle('is-open', toolsOpen);
        toggleBtn.className = toggleClasses(toolsOpen).track;
        toggleBtn.querySelector('span').className = toggleClasses(toolsOpen).knob;
        if (toolsOpen) refreshPreview();
      });

      const chipsEl = container.querySelector('#danger-preset-chips');
      const customRangeEl = container.querySelector('#danger-custom-range');
      chipsEl.innerHTML = PRESETS.map(
        (p) => `
        <button type="button" data-preset="${p.key}"
          class="danger-preset-chip ripple-host rounded-xl border px-3.5 py-2 text-sm font-medium transition-colors
                 ${preset === p.key ? 'border-[#DC2626] bg-[#DC2626] text-white' : 'border-border text-ink-secondary hover:border-[#DC2626]/30 hover:text-[#DC2626]'}">
          ${p.label}
        </button>`
      ).join('');
      chipsEl.querySelectorAll('.danger-preset-chip').forEach((btn) => {
        btn.addEventListener('click', () => {
          preset = btn.dataset.preset;
          chipsEl.querySelectorAll('.danger-preset-chip').forEach((b) => {
            const active = b.dataset.preset === preset;
            b.className = `danger-preset-chip ripple-host rounded-xl border px-3.5 py-2 text-sm font-medium transition-colors ${
              active ? 'border-[#DC2626] bg-[#DC2626] text-white' : 'border-border text-ink-secondary hover:border-[#DC2626]/30 hover:text-[#DC2626]'
            }`;
          });
          customRangeEl.classList.toggle('hidden', preset !== 'custom');
          customRangeEl.classList.toggle('flex', preset === 'custom');
          refreshPreview();
        });
      });
      attachRippleAll(chipsEl, '.danger-preset-chip');

      const startInput = container.querySelector('#danger-range-start');
      const endInput = container.querySelector('#danger-range-end');
      const today = new Date().toISOString().slice(0, 10);
      startInput.value = today;
      endInput.value = today;
      startInput.addEventListener('change', refreshPreview);
      endInput.addEventListener('change', refreshPreview);

      const deleteBtn = container.querySelector('#danger-delete-btn');
      attachRipple(deleteBtn);
      deleteBtn.addEventListener('click', async () => {
        const range = computeRange();
        if (!range || previewCount === null || previewCount === 0) return;
        const confirmed = window.confirm(
          `Remove ${previewCount} order${previewCount === 1 ? '' : 's'} (${labelFor(preset)}) from Order History and Reports & Analytics?\n\n` +
            `Customer records and their data are not affected - only these orders' visibility in History and Reports changes.`
        );
        if (!confirmed) return;
        deleteBtn.disabled = true;
        deleteBtn.textContent = 'Clearing…';
        try {
          const { deleted } = await posApi.orders.dangerDelete(range);
          toaster.success(`Cleared ${deleted} order${deleted === 1 ? '' : 's'} from History & Reports.`);
          await refreshPreview();
        } catch (err) {
          toaster.error(err.message);
          deleteBtn.disabled = false;
        } finally {
          deleteBtn.textContent = 'Clear from History & Reports';
        }
      });

      if (toolsOpen) refreshPreview();
    }

    draw();
  }

  boot().catch((err) => toaster.error('Failed to load settings: ' + err.message));

  return root;
}
