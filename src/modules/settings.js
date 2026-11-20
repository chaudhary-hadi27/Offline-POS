'use strict';

import { posApi } from '../shell/posApi.js';
import { iconMarkup } from '../shell/icons.js';
import { attachRipple, attachRippleAll } from '../shell/ripple.js';
import { toaster } from '../shell/toast.js';
import { confirmAction } from '../shell/confirmDialog.js';
import { patternSvgMarkup, wirePatternEvents, PATTERN_MIN_LENGTH } from '../shell/patternLock.js';
import { getBusinessDayStart, formatLocal, businessRangeFromDates } from '../shell/businessDay.js';
import { createBackupPanel, relativeTime } from '../shell/backupPanel.js';
import { refreshLicense, featureAccess, tierLabel, tierPillMarkup } from '../shell/license.js';
import { SAFE, LIMITS, KEYS as WA, RISK_WARNING, PROFILES, DEFAULT_PROFILE_INDEX, profileIndexOf, isRisky, estimateMinutes, formatMinutes, validate as validateTiming } from '../shell/whatsappTiming.js';

// Settings > Printer > Item names on receipt. Printing itself is handled in
// electron/print/receiptTemplate.js (receiptLanguage()).
const LANG_OPTIONS = [
  { key: 'english', label: 'English', hint: 'Every item prints with its English name only.' },
  { key: 'urdu', label: 'اردو', hint: 'Every item prints with its Urdu name only. Items without an Urdu name print in English.' },
  { key: 'both', label: 'English + اردو', hint: 'English name with the Urdu name on the line below it. Items without an Urdu name print in English only.' },
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

// Settings tabs (top bar). Only the selected tab's section is shown.
// Kept at module level so the page reopens on the tab you left it on.
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TABS = [
  { key: 'license', label: 'License', icon: 'lock' },
  { key: 'schedule', label: 'Business Day', icon: 'clock' },
  { key: 'restaurant', label: 'Restaurant & Receipt', icon: 'settings' },
  { key: 'printer', label: 'Printer', icon: 'print' },
  { key: 'whatsapp', label: 'WhatsApp', icon: 'whatsapp' },
  { key: 'lock', label: 'Security Lock', icon: 'lock' },
  { key: 'danger', label: 'Danger Zone', icon: 'alertTriangle', danger: true },
];
let activeTab = 'schedule';
let backupPanel = null; // created on first use, then reused

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
    const [settings, lockConfigured, lockType, licenseStatus] = await Promise.all([
      posApi.settings.getAll(),
      posApi.security.isConfigured(),
      posApi.security.getLockType(),
      refreshLicense(),
    ]);
    // A locked POS lands on the License tab - that is the only thing to do.
    if (licenseStatus?.locked) activeTab = 'license';

    root.innerHTML = `
      <header class="mb-6">
        <h1 class="font-display text-xl font-bold text-ink">Settings</h1>
        <p class="text-sm text-ink-secondary">Configuration</p>
      </header>
      <!-- No overflow-x here: with room to spare the tabs sit on one row, and on a narrow
           screen they WRAP onto a second row instead of showing a sideways scrollbar. -->
      <nav id="settings-tabs" class="mb-6 flex max-w-4xl flex-wrap gap-2" role="tablist" aria-label="Settings sections"></nav>
      <div class="max-w-4xl">
        <div id="license-card" data-panel="license" class="hidden"></div>
        <div id="schedule-card" data-panel="schedule" class="hidden"></div>
        <div id="info-card" data-panel="restaurant" class="hidden"></div>
        <div id="printer-card" data-panel="printer" class="hidden"></div>
        <div id="whatsapp-card" data-panel="whatsapp" class="hidden"></div>
        <div id="lock-card" data-panel="lock" class="hidden"></div>
        <div id="danger-card" data-panel="danger" class="hidden"></div>
      </div>
      <!-- Backup lives at the very end of the page (under every tab), not as a tab. -->
      <div class="mt-10 max-w-4xl border-t border-border pt-6">
        <button type="button" id="open-backup-btn"
          class="ripple-host flex w-full items-center gap-4 rounded-2xl border border-border bg-surface px-5 py-4 text-left transition-colors hover:border-accent/30">
          <span class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <span class="h-5 w-5">${iconMarkup('database')}</span>
          </span>
          <span class="flex-1">
            <span class="block font-display text-sm font-bold text-ink">Backup &amp; Restore</span>
            <span id="backup-btn-sub" class="block text-xs text-ink-secondary">Automatic offline backups of all your data</span>
          </span>
          <span class="h-4 w-4 text-ink-muted">${iconMarkup('chevronRight')}</span>
        </button>
      </div>
    `;

    renderLicenseCard(licenseStatus);
    renderScheduleCard(settings);
    renderInfoCard(settings);
    renderPrinterCard(settings);
    renderWhatsappCard(settings);
    renderLockCard(lockConfigured, lockType);
    renderDangerZoneCard(settings);
    renderTabs();
    wireBackupButton();
  }

  function wireBackupButton() {
    const btn = root.querySelector('#open-backup-btn');
    attachRipple(btn);
    btn.addEventListener('click', () => {
      if (!backupPanel) backupPanel = createBackupPanel();
      backupPanel.open();
    });
    // Show the last backup time right on the button; a problem turns it red.
    posApi.backup
      .getStatus()
      .then((s) => {
        const sub = root.querySelector('#backup-btn-sub');
        if (!sub) return;
        if (s.warnings.length > 0) {
          sub.textContent = s.warnings[0];
          sub.className = 'block text-xs text-red-600';
        } else {
          sub.textContent = `Last backup: ${relativeTime(s.lastSuccessAt)}`;
        }
      })
      .catch(() => {});
  }

  function renderTabs() {
    const tabsEl = root.querySelector('#settings-tabs');
    tabsEl.innerHTML = TABS.map((t) => {
      const on = t.key === activeTab;
      const tone = on
        ? t.danger
          ? 'border-[#DC2626] bg-[#DC2626] text-white'
          : 'border-accent bg-accent text-white'
        : t.danger
          ? 'border-border text-[#DC2626] hover:border-[#DC2626]/40'
          : 'border-border text-ink-secondary hover:border-accent/30 hover:text-accent';
      return `<button type="button" role="tab" aria-selected="${on}" data-tab="${t.key}"
        class="settings-tab ripple-host flex items-center gap-2 whitespace-nowrap rounded-xl border px-3.5 py-2 text-sm font-medium transition-colors ${tone}">
        <span class="h-4 w-4">${iconMarkup(t.icon)}</span>${t.label}
      </button>`;
    }).join('');
    tabsEl.querySelectorAll('.settings-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        renderTabs();
      });
    });
    attachRippleAll(tabsEl, '.settings-tab');
    root.querySelectorAll('[data-panel]').forEach((panel) => {
      panel.classList.toggle('hidden', panel.dataset.panel !== activeTab);
    });
  }

  // ---------------- License ----------------
  /** "What your license includes": every page with a tick, or a lock + the tier that opens it. */
  function renderIncludedPages(status) {
    const pages = status && status.pages ? Object.values(status.pages) : [];
    if (pages.length === 0) return '';
    const items = pages
      .map(
        (p) => `<li class="flex items-center gap-2 text-sm ${p.allowed ? 'text-ink' : 'text-ink-muted'}">
          <span class="h-4 w-4 flex-shrink-0 ${p.allowed ? 'text-accent' : 'text-ink-muted'}">${iconMarkup(p.allowed ? 'check' : 'lock')}</span>
          <span>${esc(p.title)}</span>${p.allowed ? '' : tierPillMarkup(p.required)}
        </li>`
      )
      .join('');
    return `<div class="mb-5">
      <span class="mb-1.5 block text-sm font-medium text-ink-secondary">Included in your license</span>
      <ul class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">${items}</ul>
      <p class="mt-2 text-xs text-ink-muted">Free = Settings only &middot; Pro = every page except WhatsApp Deals &middot; Premium = everything.</p>
    </div>`;
  }

  /** "Your licenses": every license on this PC with its state; a paused one can be started (the running one is paused). */
  function renderWalletList(status) {
    const list = status.licenses || [];
    if (list.length === 0) return '';
    const stateText = (l) =>
      l.state === 'active'
        ? `Running &middot; ${l.daysLeft} day${l.daysLeft === 1 ? '' : 's'} left`
        : l.state === 'paused'
          ? `Paused &middot; ${l.daysLeft} day${l.daysLeft === 1 ? '' : 's'} kept`
          : 'Ended';
    const rows = list
      .map(
        (l) => `<li class="flex flex-wrap items-center justify-between gap-3 rounded-xl border ${l.current && l.state !== 'expired' ? 'border-accent/40 bg-accent/5' : 'border-border'} px-4 py-3">
          <div>
            <p class="text-sm font-semibold text-ink">${esc(l.tierLabel)} <span class="font-normal text-ink-secondary">&middot; ${esc(l.planLabel || '')}</span></p>
            <p class="text-xs ${l.state === 'expired' ? 'text-red-600' : 'text-ink-secondary'}">${stateText(l)}</p>
          </div>
          ${
            l.canUse
              ? `<button type="button" data-use-license="${esc(l.slot)}" class="use-license-btn ripple-host rounded-xl border border-accent px-3.5 py-2 text-sm font-medium text-accent hover:bg-accent hover:text-white">Use this</button>`
              : ''
          }
        </li>`
      )
      .join('');
    return `<div class="mb-5">
      <span class="mb-1.5 block text-sm font-medium text-ink-secondary">Your licenses</span>
      <ul class="flex flex-col gap-2">${rows}</ul>
      ${list.length > 1 ? '<p class="mt-2 text-xs text-ink-muted">Only one runs at a time. The other is paused and its days are kept.</p>' : ''}
      ${status.notice ? `<p class="mt-2 text-xs font-medium text-accent">${esc(status.notice)}</p>` : ''}
    </div>`;
  }

  function renderLicenseCard(status) {
    const container = root.querySelector('#license-card');
    if (!status) {
      container.innerHTML = card('License', '<p class="text-sm text-ink-secondary">Could not read the license status.</p>', 'lock');
      return;
    }
    const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
    const tone =
      status.state === 'active' && !status.expiringSoon
        ? 'bg-accent/10 text-accent'
        : status.state === 'active'
          ? 'bg-red-50 text-red-600'
          : 'bg-[#DC2626] text-white';
    const stateLabel = { active: 'Active', unlicensed: 'Not activated', invalid: 'Not valid', expired: 'Expired' }[status.state] || status.state;
    const rows =
      status.state === 'active' || status.state === 'expired'
        ? `<dl class="mb-5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
             <dt class="text-ink-secondary">Tier</dt><dd class="font-medium text-ink">${esc(status.state === 'expired' ? `${tierLabel(status.licensedTier)} (expired)` : status.tierLabel || tierLabel(status.tier))}</dd>
             <dt class="text-ink-secondary">Plan</dt><dd class="font-medium text-ink">${esc(status.planLabel || status.plan || '-')}</dd>
             <dt class="text-ink-secondary">Licensed to</dt><dd class="font-medium text-ink">${esc(status.customer || '-')}</dd>
             <dt class="text-ink-secondary">Expires</dt><dd class="font-medium text-ink">${fmtDate(status.expiresAt)}${
               status.state === 'active' && status.daysLeft != null ? ` <span class="font-normal text-ink-muted">(${status.daysLeft} day${status.daysLeft === 1 ? '' : 's'} left)</span>` : ''
             }</dd>
           </dl>`
        : '';

    container.innerHTML = card(
      'License',
      `
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <span class="rounded-full px-3 py-1 text-xs font-semibold ${tone}">${stateLabel}</span>
        <span class="text-sm text-ink-secondary">${esc(status.message)}</span>
      </div>
      ${rows}
      ${renderWalletList(status)}
      ${renderIncludedPages(status)}
      ${status.clockWarning ? `<p class="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">${esc(status.clockWarning)}</p>` : ''}

      <div class="mb-5">
        <span class="mb-1.5 block text-sm font-medium text-ink-secondary">This PC's Hardware ID</span>
        <div class="flex flex-wrap items-center gap-2">
          <code id="hw-id" class="rounded-xl border border-border bg-surface-raised px-4 py-2.5 font-nums text-base font-semibold tracking-wider text-ink">${esc(status.hardwareId)}</code>
          <button type="button" id="copy-hw-btn" class="ripple-host rounded-xl border border-border px-3.5 py-2.5 text-sm font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">Copy</button>
        </div>
        <p class="mt-1.5 text-xs text-ink-muted">Send this ID to get your key. A key works only on this PC.${
          status.hardwareIdSource === 'file' ? ' This PC has no permanent ID, so reinstalling may change it.' : ''
        }</p>
      </div>

      <label class="flex flex-col gap-1.5 text-sm">
        <span class="font-medium text-ink-secondary">${status.licenses && status.licenses.length ? 'Add or renew a license key (or a repair code)' : 'License key (or repair code)'}</span>
        <textarea id="license-input" rows="4" spellcheck="false" placeholder="POS1...."
          class="break-all rounded-xl border border-border px-3.5 py-2.5 font-mono text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"></textarea>
      </label>
      <p class="mt-1.5 text-xs text-ink-muted">A higher license starts at once and pauses the lower one. Its days are kept.</p>
      <button type="button" id="activate-btn" class="ripple-host mt-4 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover">Activate</button>
      `,
      'lock'
    );

    const copyBtn = container.querySelector('#copy-hw-btn');
    attachRipple(copyBtn);
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(status.hardwareId);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(container.querySelector('#hw-id'));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      }
      toaster.success('Hardware ID copied.');
    });

    container.querySelectorAll('.use-license-btn').forEach((btn) => {
      attachRipple(btn);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const next = await posApi.license.use(btn.dataset.useLicense);
          await refreshLicense();
          toaster.success(next.notice || 'Switched.');
          renderLicenseCard(next);
        } catch (err) {
          toaster.error(err.message);
          btn.disabled = false;
        }
      });
    });

    const activateBtn = container.querySelector('#activate-btn');
    attachRipple(activateBtn);
    activateBtn.addEventListener('click', async () => {
      const input = container.querySelector('#license-input');
      activateBtn.disabled = true;
      try {
        const wasLocked = status.locked;
        const next = await posApi.license.activate(input.value);
        await refreshLicense();
        toaster.success(wasLocked && !next.locked ? 'License activated. The POS is unlocked.' : next.notice || 'Saved.');
        renderLicenseCard(next);
      } catch (err) {
        toaster.error(err.message);
      } finally {
        activateBtn.disabled = false;
      }
    });
  }

  // ---------------- WhatsApp sending speed ----------------
  function renderWhatsappCard(settings) {
    const container = root.querySelector('#whatsapp-card');
    const allowed = featureAccess('whatsapp-timing');
    if (!allowed.allowed) {
      container.innerHTML = card(
        'WhatsApp sending speed',
        `<div class="flex items-start gap-3 rounded-xl border border-border bg-surface-raised px-4 py-4">
           <span class="mt-0.5 h-5 w-5 flex-shrink-0 text-ink-muted">${iconMarkup('lock')}</span>
           <div class="text-sm text-ink-secondary">
             <p class="mb-1 font-medium text-ink">WhatsApp Deals is a Premium feature ${tierPillMarkup('premium', 'ml-1')}</p>
             <p>Upgrade to Premium to use WhatsApp Deals and change its speed.</p>
           </div>
         </div>`,
        'whatsapp'
      );
      return;
    }

    const num = (key, fallback) => (/^\d+$/.test(String(settings[key] ?? '').trim()) ? parseInt(settings[key], 10) : fallback);
    const def = PROFILES[DEFAULT_PROFILE_INDEX];
    let customOn = String(settings[WA.custom]) === '1';
    const vals = {
      contactMin: num(WA.contactMin, def.contactMin),
      contactMax: num(WA.contactMax, def.contactMax),
      groupMin: num(WA.groupMin, def.groupMin),
      groupMax: num(WA.groupMax, def.groupMax),
    };
    let accepted = false; // the risk box starts unticked on every visit - a new, faster setting needs a fresh confirmation
    let advancedOpen = profileIndexOf(vals) === -1 && customOn; // exact numbers that match no stop open the Advanced box

    const field = (id, label, value, range, unit) => `
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-ink-secondary">${label}</span>
        <span class="flex items-center gap-2">
          <input id="${id}" type="number" inputmode="numeric" min="${range.min}" max="${range.max}" step="1" value="${value}"
            class="w-24 rounded-xl border border-border px-3 py-2 text-right font-nums focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
          <span class="text-xs text-ink-muted">${unit}</span>
        </span>
      </label>`;

    const summaryText = (v) => `${v.contactMin}&ndash;${v.contactMax} seconds between customers &middot; ${v.groupMin}&ndash;${v.groupMax} minutes between groups`;

    function draw() {
      const { track, knob } = toggleClasses(customOn);
      const idx = profileIndexOf(vals);
      const risky = customOn && isRisky(vals);
      const err = customOn ? validateTiming(vals) : null;
      const eff = customOn ? vals : PROFILES[DEFAULT_PROFILE_INDEX];
      const canSave = !err && (!risky || accepted);
      const sliderIdx = idx === -1 ? DEFAULT_PROFILE_INDEX : idx;
      const label = idx === -1 ? 'Custom' : PROFILES[idx].label;
      const note = idx === -1 ? 'Your own numbers (Advanced).' : PROFILES[idx].note;
      const safeShare = ((DEFAULT_PROFILE_INDEX + 0.5) / PROFILES.length) * 100; // where the green zone ends

      const sliderBlock = `
        <div class="mb-4 rounded-xl border border-border p-4">
          <div class="mb-3 flex items-start justify-between gap-3">
            <div>
              <p class="text-xs uppercase tracking-wide text-ink-muted">Sending speed</p>
              <p id="wa-profile-label" class="text-lg font-semibold ${risky ? 'text-red-600' : 'text-ink'}">${label}${idx === DEFAULT_PROFILE_INDEX ? ' <span class="ml-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase text-accent">Recommended</span>' : ''}</p>
              <p id="wa-profile-note" class="text-xs text-ink-secondary">${note}</p>
            </div>
            <p id="wa-profile-summary" class="max-w-[14rem] text-right text-xs text-ink-secondary">${summaryText(vals)}</p>
          </div>
          <div class="relative px-1">
            <div class="pointer-events-none absolute left-1 right-1 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full">
              <div class="h-full w-full" style="background: linear-gradient(to right, #16a34a 0%, #16a34a ${safeShare}%, #f59e0b ${safeShare}%, #dc2626 100%)"></div>
            </div>
            <input id="wa-speed" type="range" min="0" max="${PROFILES.length - 1}" step="1" value="${sliderIdx}" aria-label="WhatsApp sending speed"
              class="relative z-10 h-6 w-full cursor-pointer appearance-none bg-transparent accent-white" />
          </div>
          <div class="mt-1 flex justify-between px-1 text-[10px] text-ink-muted">
            <span>Slower &middot; safer</span><span>Faster &middot; riskier</span>
          </div>
        </div>
        <div class="mb-4">
          <button type="button" id="wa-advanced-toggle" class="text-sm font-medium text-accent hover:underline">${advancedOpen ? 'Hide' : 'Advanced:'} ${advancedOpen ? 'exact numbers' : 'type exact numbers'}</button>
          ${
            advancedOpen
              ? `<div class="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                   <div class="rounded-xl border border-border p-4">
                     <p class="mb-3 text-sm font-medium text-ink">Between customers</p>
                     <div class="flex flex-wrap gap-4">
                       ${field('wa-c-min', 'Shortest', vals.contactMin, LIMITS.contact, 'seconds')}
                       ${field('wa-c-max', 'Longest', vals.contactMax, LIMITS.contact, 'seconds')}
                     </div>
                   </div>
                   <div class="rounded-xl border border-border p-4">
                     <p class="mb-3 text-sm font-medium text-ink">Between groups of 15</p>
                     <div class="flex flex-wrap gap-4">
                       ${field('wa-g-min', 'Shortest', vals.groupMin, LIMITS.group, 'minutes')}
                       ${field('wa-g-max', 'Longest', vals.groupMax, LIMITS.group, 'minutes')}
                     </div>
                   </div>
                 </div>`
              : ''
          }
        </div>
        ${err ? `<p class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">${esc(err)}</p>` : ''}
        ${
          risky && !err
            ? `<div class="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
                 <p class="mb-2 flex items-center gap-2 font-semibold"><span class="h-4 w-4">${iconMarkup('alertTriangle')}</span>Risky speed</p>
                 <p class="mb-3">${esc(RISK_WARNING)}</p>
                 <label class="flex items-start gap-2 font-medium">
                   <input id="wa-accept" type="checkbox" class="mt-0.5 h-4 w-4" ${accepted ? 'checked' : ''} />
                   <span>I accept the risk.</span>
                 </label>
               </div>`
            : ''
        }`;

      container.innerHTML = card(
        'WhatsApp sending speed',
        `
        <div class="mb-4 flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3">
          <div>
            <p class="text-sm font-medium text-ink">Adjust sending speed</p>
            <p class="text-xs text-ink-secondary">Off = always the Optimized speed.</p>
          </div>
          <button type="button" id="wa-custom-toggle" role="switch" aria-checked="${customOn}" class="${track}"><span class="${knob}"></span></button>
        </div>

        ${customOn ? sliderBlock : `<p class="mb-3 text-xs text-ink-muted">Recommended: ${summaryText(def)}.</p>`}

        <p class="mb-4 text-xs text-ink-secondary">For 100 customers this takes about <span class="font-semibold text-ink">${formatMinutes(estimateMinutes(100, eff))}</span>.</p>

        <div class="flex flex-wrap gap-2">
          <button type="button" id="wa-save" ${canSave ? '' : 'disabled'}
            class="ripple-host rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">Save</button>
          ${
            customOn
              ? `<button type="button" id="wa-reset" class="ripple-host rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">Back to Optimized</button>`
              : ''
          }
        </div>`,
        'whatsapp'
      );

      const read = () => {
        const g = (id) => parseInt(container.querySelector(id)?.value ?? '', 10);
        vals.contactMin = g('#wa-c-min');
        vals.contactMax = g('#wa-c-max');
        vals.groupMin = g('#wa-g-min');
        vals.groupMax = g('#wa-g-max');
      };

      container.querySelector('#wa-custom-toggle').addEventListener('click', () => {
        customOn = !customOn;
        accepted = false;
        draw();
      });

      // The slider: moving it fills in all four numbers from the stop. "input" only refreshes the text while
      // dragging; "change" (release / arrow key) redraws, so the warning box appears without interrupting the drag.
      const slider = container.querySelector('#wa-speed');
      if (slider) {
        const apply = (i) => {
          const p = PROFILES[i];
          vals.contactMin = p.contactMin;
          vals.contactMax = p.contactMax;
          vals.groupMin = p.groupMin;
          vals.groupMax = p.groupMax;
        };
        slider.addEventListener('input', () => {
          const i = parseInt(slider.value, 10);
          apply(i);
          const labelEl = container.querySelector('#wa-profile-label');
          labelEl.textContent = PROFILES[i].label;
          labelEl.classList.toggle('text-red-600', isRisky(vals));
          container.querySelector('#wa-profile-note').textContent = PROFILES[i].note;
          container.querySelector('#wa-profile-summary').innerHTML = summaryText(vals);
        });
        slider.addEventListener('change', () => {
          apply(parseInt(slider.value, 10));
          accepted = false; // any new speed needs a fresh confirmation
          draw();
        });
      }
      container.querySelector('#wa-advanced-toggle')?.addEventListener('click', () => {
        if (advancedOpen) read();
        advancedOpen = !advancedOpen;
        draw();
      });
      ['#wa-c-min', '#wa-c-max', '#wa-g-min', '#wa-g-max'].forEach((sel) => {
        // re-draw on "change" (not every keystroke) so typing a number is never interrupted
        container.querySelector(sel)?.addEventListener('change', () => {
          read();
          accepted = false;
          draw();
        });
      });
      container.querySelector('#wa-accept')?.addEventListener('change', (e) => {
        accepted = e.target.checked;
        draw();
      });
      container.querySelector('#wa-reset')?.addEventListener('click', () => {
        Object.assign(vals, { contactMin: def.contactMin, contactMax: def.contactMax, groupMin: def.groupMin, groupMax: def.groupMax });
        accepted = false;
        advancedOpen = false;
        draw();
      });
      const saveBtn = container.querySelector('#wa-save');
      attachRipple(saveBtn);
      saveBtn.addEventListener('click', async () => {
        if (customOn && advancedOpen) read();
        saveBtn.disabled = true;
        try {
          const entries = customOn
            ? {
                [WA.custom]: '1',
                [WA.contactMin]: String(vals.contactMin),
                [WA.contactMax]: String(vals.contactMax),
                [WA.groupMin]: String(vals.groupMin),
                [WA.groupMax]: String(vals.groupMax),
                [WA.ack]: isRisky(vals) && accepted ? '1' : '',
              }
            : { [WA.custom]: '0', [WA.ack]: '' };
          const saved = await posApi.settings.set(entries);
          Object.assign(settings, saved || entries);
          toaster.success(customOn ? 'WhatsApp sending speed saved.' : 'Using the Optimized WhatsApp speed.');
          accepted = false;
          draw();
        } catch (err) {
          toaster.error(err.message);
          saveBtn.disabled = false;
        }
      });
    }
    draw();
  }

  // ---------------- Business Day (one start time drives every day-based view) ----------------
  function renderScheduleCard(settings) {
    const container = root.querySelector('#schedule-card');

    container.innerHTML = card(
      'Business Day',
      `
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-xs text-ink-secondary">
          Day starts at
          <input type="time" name="day_start_time" value="${settings.day_start_time || '15:00'}"
            class="rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
        </label>
      </div>
      <button type="button" id="save-schedule-btn" class="ripple-host mt-4 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover">
        Save
      </button>
      `,
      'clock'
    );

    const saveBtn = container.querySelector('#save-schedule-btn');
    attachRipple(saveBtn);
    saveBtn.addEventListener('click', async () => {
      try {
        const dayStart = container.querySelector('[name="day_start_time"]').value;
        if (!dayStart) {
          toaster.error('Pick the time your business day starts.');
          return;
        }
        await posApi.settings.set({ day_start_time: dayStart });
        // Danger Zone shares this same settings object - keep it current.
        settings.day_start_time = dayStart;
        toaster.success('Business day saved.');
      } catch (err) {
        toaster.error(err.message);
      }
    });
  }

  // ---------------- Restaurant info / tax / delivery / receipt text ----------------
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

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        await posApi.settings.set(data);
        // Danger Zone / other cards share this settings object.
        Object.assign(settings, data);
        toaster.success('Settings saved.');
      } catch (err) {
        toaster.error(err.message);
      }
    });
  }

  // ---------------- Printer: receipt language, printer, width ----------------
  function renderPrinterCard(settings) {
    const container = root.querySelector('#printer-card');

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
      'Printer',
      `
      <form id="printer-form" class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5 text-sm sm:col-span-2">
          <span class="font-medium text-ink-secondary">Item names on receipt</span>
          <input type="hidden" name="receipt_language" value="${LANG_OPTIONS.some((o) => o.key === settings.receipt_language) ? settings.receipt_language : 'urdu'}" />
          <div id="receipt-lang-options" class="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Item names on receipt"></div>
          <span id="receipt-lang-hint" class="text-[11px] text-ink-muted"></span>
        </div>
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
        ${field('receipt_width_mm', 'Receipt width override (mm) - leave blank to auto-detect', settings.receipt_width_mm, 'text', 'Auto-detected from printer', true)}
        <div class="sm:col-span-2">
          <button type="submit" class="ripple-host rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover">
            Save printer settings
          </button>
        </div>
      </form>
      `,
      'print'
    );

    const form = container.querySelector('#printer-form');
    attachRipple(form.querySelector('button[type="submit"]'));

    // Receipt language: three tappable options feeding the hidden input.
    const langInput = form.querySelector('[name="receipt_language"]');
    const langEl = form.querySelector('#receipt-lang-options');
    const langHint = form.querySelector('#receipt-lang-hint');
    function renderLangOptions() {
      langEl.innerHTML = LANG_OPTIONS.map(
        (o) => `<button type="button" role="radio" aria-checked="${o.key === langInput.value}" data-lang="${o.key}"
          class="lang-opt ripple-host rounded-xl border px-2 py-2.5 text-sm font-medium transition-colors ${
            o.key === langInput.value ? 'border-accent bg-accent/10 text-accent' : 'border-border text-ink-secondary hover:border-accent/30'
          }">${o.label}</button>`
      ).join('');
      langEl.querySelectorAll('.lang-opt').forEach((btn) => {
        btn.addEventListener('click', () => {
          langInput.value = btn.dataset.lang;
          renderLangOptions();
        });
      });
      attachRippleAll(langEl, '.lang-opt');
      langHint.textContent = LANG_OPTIONS.find((o) => o.key === langInput.value)?.hint || '';
    }
    renderLangOptions();

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
        Object.assign(settings, data);
        toaster.success('Printer settings saved.');
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
      const range = businessRangeFromDates(startInput.value, endInput.value, settingsData.day_start_time);
      return { startDate: formatLocal(range.start), endDate: formatLocal(range.end) };
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
        const confirmed = await confirmAction({
          title: 'Clear orders?',
          message:
            `Remove ${previewCount} order${previewCount === 1 ? '' : 's'} (${labelFor(preset)}) from Order History and Reports & Analytics?\n\n` +
            `Customer records are not affected. Only these orders are hidden from History and Reports.`,
          confirmLabel: 'Clear',
        });
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
