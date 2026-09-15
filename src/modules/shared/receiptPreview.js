'use strict';

import { posApi } from '../../shell/posApi.js';
import { toaster } from '../../shell/toast.js';
import { iconMarkup } from '../../shell/icons.js';
import { attachRipple } from '../../shell/ripple.js';

/**
 * On-screen fallback receipt view - shown when printing fails (no
 * printer connected/configured) so the cashier isn't left with
 * nothing: they can still read the order back to a customer, or hit
 * "Try Printing Again" once a printer is available. Renders the
 * *exact* HTML the printer would have received (built server-side by
 * electron/print/receiptTemplate.js via the printer:get-receipt-html
 * channel), so this can never drift out of sync with what actually
 * prints.
 */
export async function showReceiptPreview(orderId) {
  let html;
  try {
    html = await posApi.printer.getReceiptHtml(orderId);
  } catch (err) {
    toaster.error(`Couldn't load the receipt: ${err.message}`);
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.innerHTML = `
    <div class="receipt-preview-scrim scrim-enter absolute inset-0 bg-black/60 backdrop-blur-md"></div>
    <div class="modal-pop relative flex max-h-[85vh] w-full max-w-xs flex-col rounded-2xl border border-border bg-surface shadow-modal">
      <div class="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 class="font-display text-sm font-bold text-ink">Receipt Preview</h3>
        <button type="button" id="receipt-preview-close" title="Close"
          class="ripple-host flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink">
          <span class="h-4 w-4">${iconMarkup('close')}</span>
        </button>
      </div>
      <div class="flex min-h-0 flex-1 overflow-auto bg-surface-raised p-3">
        <iframe id="receipt-preview-frame" title="Receipt preview" sandbox=""
          class="h-full min-h-[280px] w-full rounded-lg border border-border bg-white"></iframe>
      </div>
      <div class="flex justify-end gap-2 border-t border-border px-4 py-3">
        <button type="button" id="receipt-preview-print" class="ripple-host rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover">
          Try Printing Again
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector('.receipt-preview-scrim').addEventListener('click', close);
  overlay.querySelector('#receipt-preview-close').addEventListener('click', close);
  attachRipple(overlay.querySelector('#receipt-preview-close'));

  overlay.querySelector('#receipt-preview-frame').srcdoc = html;

  const printBtn = overlay.querySelector('#receipt-preview-print');
  attachRipple(printBtn);
  printBtn.addEventListener('click', async () => {
    // Dynamic import avoids a static circular dependency: printReceipt.js
    // opens this preview on failure, and this preview's retry button
    // calls back into printReceipt.js.
    const { printAndNotify } = await import('./printReceipt.js');
    const ok = await printAndNotify(orderId);
    if (ok) close();
  });
}
