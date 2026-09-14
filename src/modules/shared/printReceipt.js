'use strict';

import { posApi } from '../../shell/posApi.js';
import { toaster } from '../../shell/toast.js';

/**
 * Single entry point for sending a receipt to the printer, used both
 * right after an order is submitted (New Order) and for the one-click
 * "Reprint" action (Order History) - so both places show identical,
 * consistent success/failure feedback.
 */
export async function printAndNotify(orderId, { silent = false } = {}) {
  try {
    const result = await posApi.printer.printReceipt(orderId);
    if (!silent) {
      toaster.success(`Order #${orderId} sent to printer (${result.deviceName}).`);
    }
    return true;
  } catch (err) {
    toaster.error(`Couldn't print order #${orderId}: ${err.message}`, {
      action: {
        label: 'View Receipt',
        onClick: async () => {
          const { showReceiptPreview } = await import('./receiptPreview.js');
          showReceiptPreview(orderId);
        },
      },
    });
    return false;
  }
}
