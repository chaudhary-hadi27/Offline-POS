'use strict';

const { BrowserWindow } = require('electron');
const { buildReceiptHtml, estimateReceiptHeightMm } = require('./receiptTemplate');
const { resolveReceiptWidthMm } = require('./printerCapabilities');
const ordersRepo = require('../database/repositories/orders');
const settingsRepo = require('../database/repositories/settings');

const MM_TO_MICRONS = 1000;

/**
 * DESIGN NOTE - why this uses webContents.print() instead of raw
 * ESC/POS byte commands:
 *
 * Nearly every thermal receipt printer sold for Windows POS use ships
 * with a Windows printer driver (vendor driver, or a generic/text-only
 * driver). Once that driver is installed, the printer shows up as an
 * ordinary Windows printer by name - which means Electron's built-in,
 * well-tested print pipeline can target it directly. Hand-rolling raw
 * ESC/POS over USB/serial would require a specific printer model to
 * develop against, and is exactly the kind of thing that looks correct
 * in code review but silently fails on real hardware. This is what
 * most production Electron POS apps actually ship.
 *
 * `settings.printer_port` (set from the Settings module in Phase 4)
 * holds the exact Windows printer name (e.g. "POS-80 Series Printer"),
 * NOT a raw serial path. If it's empty, we fall back to a normal
 * (non-silent) print dialog so the cashier can pick a printer the
 * first time, before it's been configured.
 *
 * BUG HISTORY - silent print to a saved printer coming out with
 * values missing/blank, while the exact same order printed fine
 * through the non-silent system print dialog:
 * webContents.print() has no equivalent of the CSS "@page { size:
 * 80mm auto }" auto-height for a *physical*, deviceName-targeted
 * print job - it needs an exact page height up front (see
 * measureReceiptHeightMm() below). That height used to come from a
 * hand-rolled line-count guess (estimateReceiptHeightMm() in
 * receiptTemplate.js). Guessed and real height drift apart the moment
 * the template changes without the guess being updated to match - and
 * whatever content falls past a too-short guessed height (usually the
 * totals block, since it sits near the bottom) never reaches the
 * paper in *silent* mode. The non-silent path never showed this bug
 * because Windows' own print dialog quietly falls back to the
 * printer's own default paper/roll settings when it can't represent
 * our odd custom size - so a wrong guess there simply never got used.
 * The fix: measure the receipt's ACTUAL rendered height in the hidden
 * print window instead of guessing it, so silent and dialog prints
 * are built from the same real number.
 */
const PX_TO_MM = 25.4 / 96; // CSS px -> mm, at the 96dpi reference Chromium's print pipeline assumes
const PAGE_VERTICAL_MARGIN_MM = 8; // matches the CSS `@page { margin: 4mm }` in receiptTemplate.js (top + bottom) - not part of the DOM's own scrollHeight, so it has to be added back on top of the measurement

/**
 * Measures the receipt's actual rendered height in the hidden print
 * window, rather than estimating it from item/line counts. Falls back
 * to the old heuristic (estimateReceiptHeightMm) only if the
 * measurement itself fails for some reason, so a printer never
 * silently gets a completely unset page height.
 *
 * Reads scrollHeight only after `document.fonts.ready` AND a couple
 * of animation-frame turns have passed. loadURL()'s promise resolves
 * on "did-finish-load" - the main frame has loaded, but that's before
 * the Urdu Nastaliq font (if installed on the machine) has necessarily
 * finished shaping the item-name column, and before layout has fully
 * settled from it. Measuring one tick too early under-counts exactly
 * that column's height, and whatever falls past a too-short measured
 * height (almost always the totals block, since it's near the bottom)
 * never reaches the paper in silent mode - see the BUG HISTORY note
 * below for why this file measures instead of guessing in the first
 * place.
 */
async function measureReceiptHeightMm(printWindow, order, settings) {
  try {
    const contentHeightPx = await printWindow.webContents.executeJavaScript(`
      (async () => {
        if (document.fonts && document.fonts.ready) { await document.fonts.ready; }
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return document.documentElement.scrollHeight;
      })()
    `);
    if (!Number.isFinite(contentHeightPx) || contentHeightPx <= 0) throw new Error('Could not measure receipt content height.');
    const measuredMm = contentHeightPx * PX_TO_MM + PAGE_VERTICAL_MARGIN_MM;
    // Still a real measurement, not a guess - but a flat mm buffer
    // (not just a %) matters here too, since a percentage of a short
    // receipt (few items) can round down to almost nothing right when
    // a short receipt is exactly the case with the least margin for
    // error near the bottom.
    return Math.min(Math.max(measuredMm * 1.05 + 8, 120), 1500);
  } catch {
    return estimateReceiptHeightMm(order, settings);
  }
}
/**
 * Builds the exact receipt HTML for an order without printing it -
 * shared by printReceipt() (below) and the "View Receipt" on-screen
 * preview (electron/preload.js -> printer.getReceiptHtml), so what a
 * cashier sees on screen when a printer isn't available is pixel-for-
 * pixel what would have come out of the printer.
 */
function getOrderAndSettings(orderId) {
  const order = ordersRepo.getOrderWithItems(orderId);
  if (!order) {
    throw new Error(`Order #${orderId} not found - cannot print.`);
  }
  const settings = settingsRepo.getAllSettings();
  return { order, settings };
}

/**
 * Async now (was sync) - resolving the width may need to shell out to
 * PowerShell (see printerCapabilities.js). ipcMain.handle()/invoke()
 * already treat this transparently as a promise, so nothing on the
 * renderer side needs to change. Using the same resolveReceiptWidthMm()
 * as printReceipt() below is what keeps this preview genuinely
 * pixel-for-pixel with the real print job, rather than the preview
 * showing a manually-typed width while the printer silently uses its
 * own auto-detected one.
 */
async function buildReceiptHtmlForOrder(orderId) {
  const { order, settings } = getOrderAndSettings(orderId);
  const deviceName = (settings.printer_port || '').trim();
  const widthMm = await resolveReceiptWidthMm(deviceName, settings);
  return buildReceiptHtml(order, { ...settings, receipt_width_mm: widthMm });
}

async function printReceipt(orderId) {
  const { order, settings } = getOrderAndSettings(orderId);
  const deviceName = (settings.printer_port || '').trim();
  // Auto-detected from the printer's own driver config whenever possible
  // - see printerCapabilities.js for why this replaced trusting a
  // hand-typed Settings field. The resolved value is fed back into the
  // HTML (via the settings override below) so the CSS @page/body width
  // and the physical pageSize sent to the printer are always the exact
  // same number - a mismatch between those two was the root cause of
  // content clipping symmetrically off both edges.
  const widthMm = await resolveReceiptWidthMm(deviceName, settings);
  const html = buildReceiptHtml(order, { ...settings, receipt_width_mm: widthMm });

  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true },
  });

  try {
    await printWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);

    const heightMm = await measureReceiptHeightMm(printWindow, order, settings);

    const printOptions = {
      silent: Boolean(deviceName),
      printBackground: true,
      margins: { marginType: 'none' },
      // Without this, Chromium falls back to a default (Letter/A4-ish)
      // physical page for the print job while our CSS still lays the
      // receipt out for an 80mm-wide page - most of the content then
      // renders past the edge of the actual thermal roll and never
      // reaches the paper. See measureReceiptHeightMm() above for how
      // the height is obtained.
      pageSize: {
        width: Math.round(widthMm * MM_TO_MICRONS),
        height: Math.round(heightMm * MM_TO_MICRONS),
      },
      ...(deviceName ? { deviceName } : {}),
    };

    const result = await new Promise((resolve, reject) => {
      printWindow.webContents.print(printOptions, (success, failureReason) => {
        if (success) resolve({ printed: true, deviceName: deviceName || '(default printer)' });
        else reject(new Error(failureReason || 'Print job failed or was cancelled.'));
      });
    });

    return result;
  } finally {
    if (!printWindow.isDestroyed()) printWindow.close();
  }
}

module.exports = { printReceipt, buildReceiptHtmlForOrder };
