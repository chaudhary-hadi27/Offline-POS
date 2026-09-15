'use strict';

/**
 * Every channel the renderer is allowed to invoke. preload.js only
 * exposes wrappers around exactly these strings - the renderer can
 * never construct an arbitrary ipcRenderer.invoke() call, because it
 * has no direct access to ipcRenderer at all (contextIsolation: true,
 * no nodeIntegration). This file is the single source of truth so
 * main.js's handler registrations and preload.js's exposed API can
 * never silently drift apart.
 */
module.exports = Object.freeze({
  // Shifts
  SHIFT_OPEN: 'shift:open',
  SHIFT_CLOSE: 'shift:close',
  SHIFT_AUTO_CLOSE: 'shift:auto-close',
  SHIFT_GET_OPEN: 'shift:get-open',
  SHIFT_LIST: 'shift:list',
  SHIFT_GET_SALES_TOTAL: 'shift:get-sales-total',

  // Items
  ITEM_LIST: 'item:list',
  ITEM_LIST_CATEGORIES: 'item:list-categories',
  ITEM_CREATE: 'item:create',
  ITEM_UPDATE: 'item:update',
  ITEM_SET_AVAILABILITY: 'item:set-availability',
  ITEM_DELETE: 'item:delete',
  ITEM_REORDER: 'item:reorder',
  ITEM_UPLOAD_IMAGE: 'item:upload-image',
  ITEM_GET_IMAGE: 'item:get-image',
  ITEM_RENAME_CATEGORY: 'item:rename-category',
  ITEM_DELETE_CATEGORY: 'item:delete-category',

  // Seed photo gallery (bundled, read-only) - "Choose from Gallery" in Menu Setup
  SEED_GALLERY_LIST: 'seed-gallery:list',
  SEED_GALLERY_GET_IMAGE: 'seed-gallery:get-image',

  // Custom photo gallery (writable, name-tagged) - lets the admin save a
  // single named photo for Auto-Detect without needing a whole folder
  CUSTOM_GALLERY_LIST: 'custom-gallery:list',
  CUSTOM_GALLERY_CATEGORIES: 'custom-gallery:categories',
  CUSTOM_GALLERY_ADD: 'custom-gallery:add',
  CUSTOM_GALLERY_GET_IMAGE: 'custom-gallery:get-image',
  CUSTOM_GALLERY_DELETE: 'custom-gallery:delete',

  // Orders
  ORDER_CREATE: 'order:create',
  ORDER_GET: 'order:get',
  ORDER_LIST_RECENT: 'order:list-recent',
  ORDER_LIST_BY_RANGE: 'order:list-by-range',
  ORDER_LIST_BY_CUSTOMER: 'order:list-by-customer',
  ORDER_VOID: 'order:void',
  ORDER_DANGER_COUNT: 'order:danger-count',
  ORDER_DANGER_DELETE: 'order:danger-delete',
  // Hidden Records (Ctrl+K -> "hide" -> gatekeeper): read-only view of
  // whatever a Danger Zone wipe has soft-deleted.
  ORDER_LIST_DELETED: 'order:list-deleted',
  // Hidden Records -> History -> 3-dot menu -> Manage: permanent,
  // irreversible SQL delete of orders that are already soft-deleted.
  ORDER_HARD_DELETE: 'order:hard-delete',

  // Customers (secured)
  CUSTOMER_LIST: 'customer:list',
  CUSTOMER_UPSERT: 'customer:upsert',
  CUSTOMER_UPDATE: 'customer:update',
  CUSTOMER_DELETE: 'customer:delete',
  CUSTOMER_ADD_ADDRESS: 'customer:add-address',
  CUSTOMER_GET: 'customer:get',
  CUSTOMER_GET_STATS: 'customer:get-stats',
  CUSTOMER_LIST_DUPLICATES: 'customer:list-duplicates',

  // Security gatekeeper
  SECURITY_IS_CONFIGURED: 'security:is-configured',
  SECURITY_SET_LOCK: 'security:set-lock',
  SECURITY_CLEAR_LOCK: 'security:clear-lock',
  SECURITY_VERIFY: 'security:verify',
  SECURITY_GET_QUESTION: 'security:get-question',
  SECURITY_VERIFY_ANSWER: 'security:verify-answer',
  SECURITY_GET_LOCK_TYPE: 'security:get-lock-type',
  SECURITY_GET_RECOVERY_CHALLENGE: 'security:get-recovery-challenge',
  SECURITY_VERIFY_MASTER_KEY: 'security:verify-master-key',

  // Settings
  SETTINGS_GET_ALL: 'settings:get-all',
  SETTINGS_SET: 'settings:set',

  // Printer
  PRINTER_PRINT_RECEIPT: 'printer:print-receipt',
  PRINTER_GET_RECEIPT_HTML: 'printer:get-receipt-html',
  PRINTER_LIST_PRINTERS: 'printer:list-printers',

  // Analytics
  ANALYTICS_GET_SUMMARY: 'analytics:get-summary',
  // Reports half of Hidden Records - same shape, scoped to deleted orders.
  ANALYTICS_GET_DELETED_SUMMARY: 'analytics:get-deleted-summary',

  // WhatsApp Bulk Deal Sender
  WHATSAPP_INIT: 'whatsapp:init',
  WHATSAPP_GET_STATUS: 'whatsapp:get-status',
  WHATSAPP_GET_LOGS: 'whatsapp:get-logs',
  WHATSAPP_LOGOUT: 'whatsapp:logout',
  WHATSAPP_START_CAMPAIGN: 'whatsapp:start-campaign',
  WHATSAPP_RESUME_CAMPAIGN: 'whatsapp:resume-campaign',
  WHATSAPP_RETRY_FAILED: 'whatsapp:retry-failed',
  WHATSAPP_STOP_CAMPAIGN: 'whatsapp:stop-campaign',
  WHATSAPP_NEW_CAMPAIGN: 'whatsapp:new-campaign',
  WHATSAPP_GET_CAMPAIGN_STATE: 'whatsapp:get-campaign-state',
  // Push-only channel: main -> renderer. Never invoked by the renderer.
  WHATSAPP_EVENT: 'whatsapp:event',

  // WhatsApp Deal Sender - saved templates
  WHATSAPP_TEMPLATE_LIST: 'whatsapp:template-list',
  WHATSAPP_TEMPLATE_CREATE: 'whatsapp:template-create',
  WHATSAPP_TEMPLATE_UPDATE: 'whatsapp:template-update',
  WHATSAPP_TEMPLATE_DELETE: 'whatsapp:template-delete',

  // Generic relative-path -> data URL resolver, shared by template images
  WHATSAPP_IMAGE_GET: 'whatsapp:image-get',
});
