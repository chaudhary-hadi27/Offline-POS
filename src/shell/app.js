'use strict';

import { createRouter } from './router.js';
import { createCommandPalette, HIDDEN_RECORDS_MODULE_ID } from './commandPalette.js';
import { createShortcutBar, createShortcutSheet } from './shortcutBar.js';
import { createGatekeeper } from './gatekeeper.js';
import { createHiddenRecordsModal } from './hiddenRecords.js';
import { shellStore } from './state.js';
import { posApi } from './posApi.js';
import { toaster } from './toast.js';

async function applyPersistedTheme() {
  try {
    const settings = await posApi.settings.getAll();
    if (settings?.theme_mode === 'dark') {
      document.documentElement.dataset.theme = 'dark';
    }
  } catch (err) {
    console.error('[app] failed to load theme setting', err);
  }
}

export function mountApp(root) {
  const shell = document.createElement('div');
  shell.className = 'flex h-screen w-screen flex-col overflow-hidden bg-surface';

  const sheet = createShortcutSheet();
  const gatekeeper = createGatekeeper();
  const hiddenRecords = createHiddenRecordsModal();

  // "hide" in the palette never reaches router.navigate() - it's not
  // a route and never appears on the dashboard/dock (see
  // commandPalette.js). Committing it gates on the SAME gatekeeper
  // every other secured module uses (whatever PIN/password/pattern is
  // already set in Settings), then opens the Hidden Records popup
  // directly instead.
  const palette = createCommandPalette({
    onNavigate: async (id) => {
      if (id === HIDDEN_RECORDS_MODULE_ID) {
        const granted = await gatekeeper.requireAccess();
        if (granted) hiddenRecords.open();
        return;
      }
      router.navigate(id);
    },
  });

  const router = createRouter({
    onRequestPalette: () => palette.open(),
    requireAccess: gatekeeper.requireAccess,
  });
  const shortcutBar = createShortcutBar({
    onRequestOpen: () => sheet.open(shellStore.get().route),
  });

  shell.appendChild(router.el);
  shell.appendChild(shortcutBar.el);
  root.appendChild(shell);

  shellStore.subscribe((state) => shortcutBar.render(state.route));

  // The ONE global keydown handler for the whole app (brief section 6):
  // Ctrl/Cmd+K opens the command palette, Ctrl/Cmd+/ opens the
  // shortcut sheet, Escape closes whichever overlay is currently
  // open. Every module added in later phases reuses this instead of
  // adding its own document-level listener.
  //
  // Deliberately NOT a bare function key (F1 used to be bound here):
  // on most laptop keyboards - especially the common Dell/HP/Lenovo
  // models sold locally - the F-row is remapped at the firmware/BIOS
  // level to hardware functions (mute, volume, brightness, etc.) by
  // default, and toggling that off is an OS-level setting most
  // cashiers will never touch. The keydown event for F1 often never
  // even reaches the app in that mode. Ctrl+/ is the same "show
  // keyboard shortcuts" convention used by Slack, Gmail, Trello and
  // GitHub - recognizable, and never claimed by hardware.
  document.addEventListener('keydown', (event) => {
    const isCommandK = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
    if (isCommandK) {
      event.preventDefault();
      palette.isOpen() ? palette.close() : palette.open();
      return;
    }
    const isShortcutsKey = (event.ctrlKey || event.metaKey) && event.key === '/';
    if (isShortcutsKey) {
      event.preventDefault();
      sheet.isOpen() ? sheet.close() : sheet.open(shellStore.get().route);
      return;
    }
    if (event.key === 'Escape') {
      if (palette.isOpen()) {
        palette.close();
        event.stopImmediatePropagation();
      } else if (sheet.isOpen()) {
        sheet.close();
        event.stopImmediatePropagation();
      } else if (gatekeeper.isOpen()) {
        gatekeeper.cancel();
        event.stopImmediatePropagation();
      } else if (hiddenRecords.isOpen()) {
        hiddenRecords.close();
        event.stopImmediatePropagation();
      }
    }
  });

  applyPersistedTheme();
  watchBackupHealth();
}

/**
 * Backups run on their own (electron/backup/backupService.js); this just
 * makes sure someone NOTICES if they stop working - e.g. the USB drive
 * was unplugged, or no backup has succeeded for 2+ days. Checked a minute
 * after start (so the startup backup has had its chance) and every 6 hours.
 */
function watchBackupHealth() {
  const check = async () => {
    try {
      const status = await posApi.backup.getStatus();
      if (status.warnings.length > 0) {
        toaster.error(`Backup problem: ${status.warnings[0]} Open Settings > Backup & Restore.`, { duration: 12000 });
      }
    } catch (err) {
      console.error('[app] backup health check failed', err);
    }
  };
  setTimeout(check, 60000);
  setInterval(check, 6 * 60 * 60 * 1000);
}
