'use strict';

import { posApi } from './posApi.js';
import { iconMarkup } from './icons.js';
import { attachRipple, attachRippleAll } from './ripple.js';
import { toaster } from './toast.js';
import { confirmAction } from './confirmDialog.js';

/**
 * Backup & Restore screen - opened by the button at the very end of the
 * Settings page. Full-screen like Hidden Records, with the Close button
 * at the LEFT of the header (inside the POS, away from the Windows
 * window controls in the top-right corner).
 *
 * Nothing here is needed for backups to happen: they run by themselves
 * (see electron/backup/backupService.js). This screen only SHOWS what
 * the automatic system has done, lets the owner pick a second (USB /
 * other-disk) folder once, force a backup, and restore.
 */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function formatBytes(n) {
  if (n == null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatWhen(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function createBackupPanel() {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 hidden flex-col bg-surface';
  overlay.innerHTML = `
    <header class="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-6 py-3.5">
      <button type="button" class="bk-close ripple-host flex h-10 flex-shrink-0 items-center gap-2 rounded-xl bg-accent px-3.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-hover" title="Close Backup" aria-label="Close Backup">
        <span class="h-5 w-5">${iconMarkup('close')}</span>
        <span>Close</span>
      </button>
      <span class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <span class="h-5 w-5">${iconMarkup('database')}</span>
      </span>
      <h1 class="font-display text-base font-bold text-ink">Backup &amp; Restore</h1>
    </header>
    <div class="flex-1 overflow-y-auto px-6 py-6">
      <div id="bk-body" class="mx-auto flex max-w-4xl flex-col gap-5"></div>
    </div>
    <div id="bk-busy" class="absolute inset-0 hidden items-center justify-center bg-surface/85 backdrop-blur-sm">
      <p id="bk-busy-text" class="rounded-2xl border border-border bg-surface px-6 py-4 text-sm font-medium text-ink shadow-modal"></p>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector('#bk-body');
  const busyEl = overlay.querySelector('#bk-busy');
  const busyText = overlay.querySelector('#bk-busy-text');
  const closeBtn = overlay.querySelector('.bk-close');
  attachRipple(closeBtn);

  let status = null;
  let activeLocation = 'local';
  let snapshots = [];
  let opened = false;
  // The list is naturally short (retention keeps a fixed set), but it can
  // still run to a couple of dozen rows - show the newest few, with "Show more".
  const PAGE = 8;
  let visibleCount = PAGE;

  function setBusy(text) {
    if (text) {
      busyText.textContent = text;
      busyEl.classList.remove('hidden');
      busyEl.classList.add('flex');
    } else {
      busyEl.classList.add('hidden');
      busyEl.classList.remove('flex');
    }
  }

  function destinationCard(d) {
    const ok = d.available && !d.lastError;
    const pill = !d.available
      ? '<span class="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">Not found</span>'
      : d.lastError
        ? '<span class="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">Last run failed</span>'
        : d.count > 0
          ? '<span class="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">OK</span>'
          : '<span class="rounded-full bg-border-strong/40 px-2 py-0.5 text-[11px] font-medium text-ink-muted">No backup yet</span>';
    return `
      <section class="rounded-2xl border border-border bg-surface p-5">
        <div class="mb-1 flex items-center justify-between gap-2">
          <h2 class="font-display text-sm font-bold text-ink">${esc(d.label)}</h2>${pill}
        </div>
        <p class="mb-3 break-all text-xs text-ink-muted">${esc(d.root)}</p>
        <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt class="text-ink-secondary">Last backup</dt><dd class="font-medium text-ink">${d.lastSuccessAt ? esc(relativeTime(d.lastSuccessAt)) : 'never'}</dd>
          <dt class="text-ink-secondary">Backups kept</dt><dd class="font-medium text-ink">${d.count}</dd>
          <dt class="text-ink-secondary">Orders in latest</dt><dd class="font-nums font-medium text-ink">${d.latest?.orders ?? '-'}</dd>
        </dl>
        ${ok ? '' : d.lastError ? `<p class="mt-3 text-xs text-red-600">${esc(d.lastError)}</p>` : ''}
        ${
          d.id === 'external'
            ? `<div class="mt-4 flex flex-wrap gap-2">
                 <button type="button" data-act="pick-external" class="bk-btn ripple-host rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">Change folder</button>
                 <button type="button" data-act="clear-external" class="bk-btn ripple-host rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">Stop using this</button>
               </div>`
            : ''
        }
      </section>`;
  }

  function externalCta() {
    return `
      <section class="flex flex-col justify-between rounded-2xl border border-dashed border-border-strong p-5">
        <div>
          <h2 class="font-display text-sm font-bold text-ink">External drive / folder</h2>
          <p class="mt-1 text-sm text-ink-secondary">Pick a folder on a USB drive or a different disk. Every backup is then copied there too, automatically - this is the copy that survives a dead hard disk.</p>
        </div>
        <button type="button" data-act="pick-external" class="bk-btn ripple-host mt-4 self-start rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover">Choose folder</button>
      </section>`;
  }

  function historyTable() {
    const tabs = (status?.destinations || [])
      .map(
        (d) => `<button type="button" data-loc="${d.id}" class="bk-loc rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
          d.id === activeLocation ? 'border-accent bg-accent/10 text-accent' : 'border-border text-ink-secondary hover:border-accent/30'
        }">${esc(d.label)}</button>`
      )
      .join('');
    const shown = snapshots.slice(0, visibleCount);
    const hidden = snapshots.length - shown.length;
    const rows = snapshots.length
      ? shown
          .map(
            (s, i) => `
          <tr class="border-t border-border">
            <td class="px-4 py-3"><div class="font-medium text-ink">${esc(formatWhen(s.createdAt))}</div>${i === 0 ? '<div class="text-[11px] text-accent">Latest</div>' : ''}</td>
            <td class="px-4 py-3 font-nums text-ink-secondary">${s.orders ?? '-'}</td>
            <td class="px-4 py-3 font-nums text-ink-secondary">${s.items ?? '-'}</td>
            <td class="px-4 py-3 font-nums text-ink-secondary">${s.customers ?? '-'}</td>
            <td class="px-4 py-3 text-ink-secondary">${formatBytes(s.sizeBytes)}</td>
            <td class="px-4 py-3 text-right">
              <button type="button" data-restore="${esc(s.name)}" class="bk-btn ripple-host rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">Restore</button>
            </td>
          </tr>`
          )
          .join('')
      : `<tr><td colspan="6" class="px-4 py-10 text-center text-sm text-ink-secondary">No backups here yet.</td></tr>`;
    return `
      <section class="rounded-2xl border border-border bg-surface">
        <div class="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
          <h2 class="font-display text-sm font-bold text-ink">Saved backups</h2>
          <div class="flex gap-1.5">${tabs}</div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="bg-surface-raised text-xs uppercase tracking-wide text-ink-muted">
              <tr><th class="px-4 py-3 font-medium">Date</th><th class="px-4 py-3 font-medium">Orders</th><th class="px-4 py-3 font-medium">Items</th><th class="px-4 py-3 font-medium">Customers</th><th class="px-4 py-3 font-medium">Size</th><th class="px-4 py-3 font-medium text-right">Action</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${hidden > 0 ? `<div class="border-t border-border px-5 py-3 text-center"><button type="button" data-act="show-more" class="bk-btn ripple-host rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:border-accent/30 hover:text-accent">Show ${hidden} older backup${hidden === 1 ? '' : 's'}</button></div>` : ''}
      </section>`;
  }

  function render() {
    if (!status) {
      body.innerHTML = '<p class="text-sm text-ink-secondary">Loading...</p>';
      return;
    }
    const warnings = status.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
    const advice = status.advice.map((w) => `<li>${esc(w)}</li>`).join('');
    const hasExternal = status.destinations.some((d) => d.id === 'external');
    body.innerHTML = `
      <section class="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-surface p-5">
        <div>
          <h2 class="font-display text-sm font-bold text-ink">Automatic backup is on</h2>
          <p class="mt-1 text-sm text-ink-secondary">Runs by itself when the POS starts and every ${status.intervalHours} hours while it stays open. Last successful backup: <span class="font-medium text-ink">${esc(relativeTime(status.lastSuccessAt))}</span>.</p>
        </div>
        <button type="button" data-act="run-now" class="bk-btn ripple-host rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover">Back up now</button>
      </section>
      ${warnings ? `<ul class="list-disc rounded-2xl border border-red-200 bg-red-50 py-4 pl-9 pr-5 text-sm text-red-700">${warnings}</ul>` : ''}
      ${advice ? `<ul class="list-disc rounded-2xl border border-border bg-surface-raised py-4 pl-9 pr-5 text-sm text-ink-secondary">${advice}</ul>` : ''}
      <div class="grid grid-cols-1 gap-5 md:grid-cols-2">
        ${status.destinations.map(destinationCard).join('')}
        ${hasExternal ? '' : externalCta()}
      </div>
      ${historyTable()}
    `;
    attachRippleAll(body, '.bk-btn');
    wire();
  }

  async function refresh({ reloadList = true } = {}) {
    status = await posApi.backup.getStatus();
    if (!status.destinations.some((d) => d.id === activeLocation)) activeLocation = 'local';
    if (reloadList) snapshots = await posApi.backup.list(activeLocation);
    render();
  }

  async function guarded(busyMessage, fn) {
    try {
      setBusy(busyMessage);
      await fn();
    } catch (err) {
      toaster.error(err.message);
    } finally {
      setBusy(null);
    }
  }

  function wire() {
    body.querySelectorAll('[data-act="run-now"]').forEach((btn) =>
      btn.addEventListener('click', () =>
        guarded('Backing up...', async () => {
          const r = await posApi.backup.runNow();
          if (r.ok) toaster.success('Backup complete.');
          else if (r.skipped) toaster.show('A backup is already running.');
          else toaster.error(r.error || (r.results || []).filter((x) => !x.ok).map((x) => x.error).join(' | ') || 'Backup failed.');
          await refresh();
        })
      )
    );
    body.querySelectorAll('[data-act="pick-external"]').forEach((btn) =>
      btn.addEventListener('click', () =>
        guarded('Choosing folder...', async () => {
          await posApi.backup.pickExternalFolder();
          const existing = await posApi.backup.list('external');
          if (existing.length > 0) {
            // This folder already holds backups (e.g. the old PC's USB drive).
            // Do NOT push a new backup into it - this PC may be brand new and
            // empty. Show them so they can be restored instead.
            activeLocation = 'external';
            visibleCount = PAGE;
            toaster.show(`Found ${existing.length} existing backup${existing.length === 1 ? '' : 's'} in this folder - pick one under Saved backups to restore it.`, { duration: 10000 });
          } else {
            const r = await posApi.backup.runNow(); // copy the first backup there straight away
            if (r.ok) toaster.success('External folder set and first copy made.');
          }
          await refresh();
        })
      )
    );
    body.querySelectorAll('[data-act="clear-external"]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const ok = await confirmAction({
          title: 'Stop using the external folder?',
          message: 'New backups will only go to this PC. Backups already in that folder are not deleted.',
          confirmLabel: 'Stop using',
          tone: 'default',
        });
        if (!ok) return;
        await guarded('Saving...', async () => {
          await posApi.backup.clearExternalFolder();
          activeLocation = 'local';
          await refresh();
        });
      })
    );
    body.querySelectorAll('[data-act="show-more"]').forEach((btn) =>
      btn.addEventListener('click', () => {
        visibleCount += PAGE;
        render();
      })
    );
    body.querySelectorAll('.bk-loc').forEach((btn) =>
      btn.addEventListener('click', () =>
        guarded('Loading...', async () => {
          activeLocation = btn.dataset.loc;
          visibleCount = PAGE;
          await refresh();
        })
      )
    );
    body.querySelectorAll('[data-restore]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const snap = snapshots.find((s) => s.name === btn.dataset.restore);
        if (!snap) return;
        const ok = await confirmAction({
          title: 'Restore this backup?',
          message: `This replaces ALL current data (orders, customers, menu, settings) with the backup from ${formatWhen(snap.createdAt)} (${snap.orders ?? '?'} orders). Anything entered since then is lost. A safety copy of the current data is saved first, and the POS restarts afterwards.`,
          confirmLabel: 'Restore',
          tone: 'danger',
          requireTypedConfirmation: 'RESTORE',
        });
        if (!ok) return;
        try {
          setBusy('Restoring - the POS will restart in a moment...');
          await posApi.backup.restore(activeLocation, snap.name);
          toaster.success('Backup restored. Restarting...', { duration: 6000 });
          // The busy overlay stays up: the main process relaunches the app.
        } catch (err) {
          setBusy(null);
          toaster.error(err.message);
        }
      })
    );
  }

  function onKey(e) {
    if (e.key === 'Escape' && opened && busyEl.classList.contains('hidden')) close();
  }

  async function open() {
    opened = true;
    activeLocation = 'local';
    visibleCount = PAGE;
    status = null;
    snapshots = [];
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
    document.addEventListener('keydown', onKey);
    render();
    try {
      await refresh();
    } catch (err) {
      toaster.error(err.message);
    }
  }

  function close() {
    opened = false;
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
    document.removeEventListener('keydown', onKey);
  }

  closeBtn.addEventListener('click', close);

  return { open, close, isOpen: () => opened };
}
