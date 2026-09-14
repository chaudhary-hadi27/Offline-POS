'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const CH = require('./ipc-channels');

// webUtils.getPathForFile is the modern (Electron 32+), non-deprecated
// way to resolve a File object picked in an <input type="file"> to a
// real absolute filesystem path. This app currently targets an older
// Electron, where that path is still available directly on the File
// object as `.path` - so we prefer webUtils when present and fall back
// to `.path` otherwise, meaning this keeps working across an Electron
// upgrade without any renderer-side changes.
let webUtils = null;
try {
  ({ webUtils } = require('electron'));
} catch (err) {
  webUtils = null;
}

/**
 * Every call goes through this single choke point. It unwraps the
 * { success, data } / { success:false, error } envelope from main.js
 * so renderer code can write plain:
 *
 *   try {
 *     const item = await window.pos.items.create({...});
 *   } catch (err) {
 *     showToast(err.message);
 *   }
 *
 * instead of manually checking `.success` after every single call.
 */
async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (!response || response.success !== true) {
    throw new Error((response && response.error) || `IPC call to "${channel}" failed.`);
  }
  return response.data;
}

// The ENTIRE surface the renderer can ever reach. There is no way
// for renderer code to call ipcRenderer.invoke() directly - it does
// not have ipcRenderer at all, only whatever we explicitly attach
// here via contextBridge. nodeIntegration is off, so there is also
// no require()/process/fs available in the renderer.
contextBridge.exposeInMainWorld('pos', {
  shifts: {
    open: (payload) => invoke(CH.SHIFT_OPEN, payload),
    close: (shiftId, payload) => invoke(CH.SHIFT_CLOSE, shiftId, payload),
    autoClose: (shiftId) => invoke(CH.SHIFT_AUTO_CLOSE, shiftId),
    getOpen: () => invoke(CH.SHIFT_GET_OPEN),
    list: (opts) => invoke(CH.SHIFT_LIST, opts),
    getSalesTotal: (shiftId) => invoke(CH.SHIFT_GET_SALES_TOTAL, shiftId),
  },

  items: {
    list: (opts) => invoke(CH.ITEM_LIST, opts),
    listCategories: () => invoke(CH.ITEM_LIST_CATEGORIES),
    create: (payload) => invoke(CH.ITEM_CREATE, payload),
    update: (id, payload) => invoke(CH.ITEM_UPDATE, id, payload),
    setAvailability: (id, isAvailable) => invoke(CH.ITEM_SET_AVAILABILITY, id, isAvailable),
    remove: (id) => invoke(CH.ITEM_DELETE, id),
    reorder: (orderedIds) => invoke(CH.ITEM_REORDER, orderedIds),
    uploadImage: (id, dataUrl) => invoke(CH.ITEM_UPLOAD_IMAGE, id, dataUrl),
    getImage: (relativePath) => invoke(CH.ITEM_GET_IMAGE, relativePath),
    renameCategory: (oldName, newName) => invoke(CH.ITEM_RENAME_CATEGORY, oldName, newName),
    deleteCategory: (categoryName, options) => invoke(CH.ITEM_DELETE_CATEGORY, categoryName, options),
  },
  seedGallery: {
    list: () => invoke(CH.SEED_GALLERY_LIST),
    getImage: (category, filename) => invoke(CH.SEED_GALLERY_GET_IMAGE, category, filename),
  },
  customGallery: {
    list: () => invoke(CH.CUSTOM_GALLERY_LIST),
    categories: () => invoke(CH.CUSTOM_GALLERY_CATEGORIES),
    add: (name, category, dataUrl) => invoke(CH.CUSTOM_GALLERY_ADD, name, category, dataUrl),
    getImage: (filename) => invoke(CH.CUSTOM_GALLERY_GET_IMAGE, filename),
    remove: (filename) => invoke(CH.CUSTOM_GALLERY_DELETE, filename),
  },

  orders: {
    create: (payload) => invoke(CH.ORDER_CREATE, payload),
    get: (orderId) => invoke(CH.ORDER_GET, orderId),
    listRecent: (opts) => invoke(CH.ORDER_LIST_RECENT, opts),
    listByRange: (opts) => invoke(CH.ORDER_LIST_BY_RANGE, opts),
    listByCustomer: (customerId, opts) => invoke(CH.ORDER_LIST_BY_CUSTOMER, customerId, opts),
    void: (orderId) => invoke(CH.ORDER_VOID, orderId),
    dangerCount: (opts) => invoke(CH.ORDER_DANGER_COUNT, opts),
    dangerDelete: (opts) => invoke(CH.ORDER_DANGER_DELETE, opts),
    listDeleted: (opts) => invoke(CH.ORDER_LIST_DELETED, opts),
  },

  customers: {
    list: (opts) => invoke(CH.CUSTOMER_LIST, opts),
    upsert: (payload) => invoke(CH.CUSTOMER_UPSERT, payload),
    update: (customerId, payload) => invoke(CH.CUSTOMER_UPDATE, customerId, payload),
    remove: (customerId) => invoke(CH.CUSTOMER_DELETE, customerId),
    addAddress: (customerId, payload) => invoke(CH.CUSTOMER_ADD_ADDRESS, customerId, payload),
    get: (customerId) => invoke(CH.CUSTOMER_GET, customerId),
    getStats: (customerId) => invoke(CH.CUSTOMER_GET_STATS, customerId),
    listDuplicates: () => invoke(CH.CUSTOMER_LIST_DUPLICATES),
  },

  security: {
    isConfigured: () => invoke(CH.SECURITY_IS_CONFIGURED),
    setLock: (payload) => invoke(CH.SECURITY_SET_LOCK, payload),
    clearLock: () => invoke(CH.SECURITY_CLEAR_LOCK),
    verify: (candidate) => invoke(CH.SECURITY_VERIFY, candidate),
    getQuestion: () => invoke(CH.SECURITY_GET_QUESTION),
    verifyAnswer: (candidate) => invoke(CH.SECURITY_VERIFY_ANSWER, candidate),
    getLockType: () => invoke(CH.SECURITY_GET_LOCK_TYPE),
    getRecoveryChallenge: () => invoke(CH.SECURITY_GET_RECOVERY_CHALLENGE),
    verifyMasterKey: (candidateKey) => invoke(CH.SECURITY_VERIFY_MASTER_KEY, candidateKey),
  },

  settings: {
    getAll: () => invoke(CH.SETTINGS_GET_ALL),
    set: (entries) => invoke(CH.SETTINGS_SET, entries),
  },

  printer: {
    printReceipt: (orderId) => invoke(CH.PRINTER_PRINT_RECEIPT, orderId),
    getReceiptHtml: (orderId) => invoke(CH.PRINTER_GET_RECEIPT_HTML, orderId),
    listPrinters: () => invoke(CH.PRINTER_LIST_PRINTERS),
  },

  analytics: {
    getSummary: (range) => invoke(CH.ANALYTICS_GET_SUMMARY, range),
    getDeletedSummary: (range) => invoke(CH.ANALYTICS_GET_DELETED_SUMMARY, range),
  },

  files: {
    // Resolves a browser File object (e.g. from <input type="file">)
    // to an absolute path on disk, for handing off to Node/Electron
    // APIs that need a real filesystem path (like MessageMedia.fromFilePath).
    getPathForFile: (file) => {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
      return file && file.path ? file.path : null;
    },
  },

  whatsapp: {
    init: () => invoke(CH.WHATSAPP_INIT),
    getStatus: () => invoke(CH.WHATSAPP_GET_STATUS),
    getLogs: () => invoke(CH.WHATSAPP_GET_LOGS),
    logout: () => invoke(CH.WHATSAPP_LOGOUT),
    getCampaignState: () => invoke(CH.WHATSAPP_GET_CAMPAIGN_STATE),
    startCampaign: (payload) => invoke(CH.WHATSAPP_START_CAMPAIGN, payload),
    resumeCampaign: () => invoke(CH.WHATSAPP_RESUME_CAMPAIGN),
    retryFailed: () => invoke(CH.WHATSAPP_RETRY_FAILED),
    stopCampaign: () => invoke(CH.WHATSAPP_STOP_CAMPAIGN),
    newCampaign: () => invoke(CH.WHATSAPP_NEW_CAMPAIGN),
    // Push-only channel from main -> renderer. Returns an unsubscribe
    // function so a module can cleanly detach when it unmounts.
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(CH.WHATSAPP_EVENT, listener);
      return () => ipcRenderer.removeListener(CH.WHATSAPP_EVENT, listener);
    },
    templates: {
      list: () => invoke(CH.WHATSAPP_TEMPLATE_LIST),
      create: (payload) => invoke(CH.WHATSAPP_TEMPLATE_CREATE, payload),
      update: (id, payload) => invoke(CH.WHATSAPP_TEMPLATE_UPDATE, id, payload),
      remove: (id) => invoke(CH.WHATSAPP_TEMPLATE_DELETE, id),
    },
    getImage: (relativePath) => invoke(CH.WHATSAPP_IMAGE_GET, relativePath),
  },
});
