'use strict';

const { execFile } = require('child_process');

/**
 * WHY THIS EXISTS:
 *
 * The old flow trusted a hand-typed `receipt_width_mm` Settings field as
 * the physical roll width and forced that exact value onto the silent
 * print job's `pageSize`. Two ways that goes wrong in production:
 *   1. Whoever sets up the till mis-types it (58 vs 80), or the roll gets
 *      swapped for a different width and nobody updates Settings.
 *   2. Even when correct, some drivers silently substitute their own
 *      nearest supported width for an arbitrary custom pageSize - which
 *      is exactly why the non-silent system print dialog "just works"
 *      even with a wrong guess (see BUG HISTORY in printReceipt.js): the
 *      dialog defers to what the driver/OS actually knows about the
 *      printer, our guess never gets used.
 *
 * The fix applies that same "trust the driver, not a guess" idea to the
 * silent path too - by reading the width the driver itself is configured
 * with, straight from Windows, instead of asking a human to know and
 * correctly type their thermal roll's millimetre width.
 *
 * Win32_PrinterConfiguration.PaperWidth is the OS's own record of the
 * paper form currently selected for that printer (in tenths of a mm) -
 * the same value the driver uses to lay out any print job, silent or
 * not. Reading it directly removes the guess entirely for the vast
 * majority of Windows thermal printer drivers, which do populate it.
 */

const CACHE_TTL_MS = 60 * 60 * 1000; // re-check hourly - cheap enough to be safe if a roll/printer is swapped, expensive enough (powershell cold-start) to not do on every single receipt
const DETECTION_TIMEOUT_MS = 4000; // a hung/slow WMI call must never block or fail a print - see resolveReceiptWidthMm's fallback chain
const paperWidthCache = new Map(); // deviceName -> { widthMm, expiresAt }

/**
 * Asks Windows what paper width the given printer's driver is actually
 * configured for. Returns a plain number of millimetres, or null if this
 * isn't Windows, no printer is selected, the printer doesn't report
 * PaperWidth, or anything about the query fails - callers must treat
 * null as "unknown" and fall back, never as "0mm".
 *
 * The printer name is passed through an environment variable rather than
 * interpolated into the PowerShell command string, so a printer name
 * containing quotes or other shell-meaningful characters can never break
 * out of the query - it's just inert data to the script.
 */
function detectPrinterPaperWidthMm(deviceName) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !deviceName) {
      resolve(null);
      return;
    }

    const script = `
      $name = $env:POS_PRINTER_NAME.Replace("'", "''")
      $cfg = Get-CimInstance -ClassName Win32_PrinterConfiguration -Filter ("Name='" + $name + "'") -ErrorAction SilentlyContinue
      if ($cfg -and $cfg.PaperWidth) {
        [PSCustomObject]@{ paperWidthTenthsMm = $cfg.PaperWidth } | ConvertTo-Json -Compress
      }
    `;

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        timeout: DETECTION_TIMEOUT_MS,
        env: { ...process.env, POS_PRINTER_NAME: deviceName },
      },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          const tenthsMm = Number(parsed.paperWidthTenthsMm);
          if (!Number.isFinite(tenthsMm) || tenthsMm <= 0) {
            resolve(null);
            return;
          }
          resolve(tenthsMm / 10);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/** Cached wrapper around detectPrinterPaperWidthMm() - see CACHE_TTL_MS above. A failed detection is NOT cached, so a transient WMI hiccup on one receipt doesn't lock in "unknown" for an hour. */
async function getCachedPaperWidthMm(deviceName) {
  const cached = paperWidthCache.get(deviceName);
  if (cached && cached.expiresAt > Date.now()) return cached.widthMm;

  const widthMm = await detectPrinterPaperWidthMm(deviceName);
  if (widthMm) paperWidthCache.set(deviceName, { widthMm, expiresAt: Date.now() + CACHE_TTL_MS });
  return widthMm;
}

/** Drops any cached width for a printer - call this after the user picks/changes the saved printer in Settings, so a stale width from a previously-selected printer can never leak into the next print. */
function invalidatePaperWidthCache(deviceName) {
  if (deviceName) paperWidthCache.delete(deviceName);
  else paperWidthCache.clear();
}

/**
 * Resolves the width to actually print at, in this priority order:
 *   1. Auto-detected from the selected printer's own driver config -
 *      the production-grade source of truth, needs no human input.
 *   2. A manual `receipt_width_mm` override in Settings, if the cashier
 *      set one - kept only as an escape hatch for the rare driver that
 *      doesn't expose PaperWidth via WMI, or for non-Windows/dev use.
 *   3. 80mm - the most common thermal roll size, as an absolute last
 *      resort so a print job is never sent with a completely unset width.
 */
async function resolveReceiptWidthMm(deviceName, settings) {
  if (deviceName) {
    const detected = await getCachedPaperWidthMm(deviceName);
    if (detected) return detected;
  }

  const manual = Number(settings.receipt_width_mm);
  if (Number.isFinite(manual) && manual > 0) return manual;

  return 80;
}

module.exports = { resolveReceiptWidthMm, invalidatePaperWidthCache };
