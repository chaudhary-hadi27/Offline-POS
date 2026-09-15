'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// MUST run before whatsapp-web.js / puppeteer are required below.
// Puppeteer downloads its own Chromium browser at `npm install` time into
// a *cache folder outside node_modules* (normally the developer's own
// user-profile folder, e.g. C:\Users\<dev>\.cache\puppeteer). That cache
// is never part of the installed .exe, which is why WhatsApp connects
// fine on the developer's machine but fails with "Connection failed" on
// every machine that only ever ran the installer - Chromium simply isn't
// there to launch. In the PACKAGED app only, point Puppeteer at the copy
// of Chrome bundled into the installer (see scripts/download-chrome.js +
// package.json "extraResources") instead of that per-user cache folder.
// In dev, leave Puppeteer's normal per-user cache alone so `npm start`
// keeps working unchanged on whatever OS the developer is on.
if (app.isPackaged) {
  process.env.PUPPETEER_CACHE_DIR = path.join(process.resourcesPath, 'puppeteer-cache');
}

const CH = require('./ipc-channels');
const { initDatabase, closeDatabase } = require('./database/db');
const { seedMenuIfEmpty, backfillMissingUrduNames } = require('./database/seedItems');

// Repositories - the ONLY place in the app that touches SQL.
const shiftsRepo = require('./database/repositories/shifts');
const itemsRepo = require('./database/repositories/items');
const seedGallery = require('./database/seedGallery');
const customGallery = require('./images/customGallery');
const ordersRepo = require('./database/repositories/orders');
const customersRepo = require('./database/repositories/customers');
const securityRepo = require('./database/repositories/security');
const settingsRepo = require('./database/repositories/settings');
const analyticsRepo = require('./database/repositories/analytics');
const whatsappMarketingRepo = require('./database/repositories/whatsappMarketing');
const { printReceipt, buildReceiptHtmlForOrder } = require('./print/printReceipt');
const { invalidatePaperWidthCache } = require('./print/printerCapabilities');
const { getOrCreateMachineId } = require('./security/machineId');
const { generateChallenge, verifyMasterKey } = require('./security/masterKeyRecovery');
const { saveItemImage, saveTemplateImage, getItemImageDataUrl, deleteItemImage } = require('./images/imageStore');
const whatsappService = require('./whatsapp/whatsappService');

const isDev = !app.isPackaged;

// Single instance lock: a POS app spawning twice would mean two
// processes writing to the same SQLite file. Refuse the second launch
// and focus the existing window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let machineId = null;
let userDataDir = null;

// The window/taskbar icon while the app is running. Drop your logo at
// build/icon.png (see build/README.md) - this picks it up automatically,
// with no code changes needed. Falls back to Electron's default icon if
// the file isn't there yet, so this never breaks the dev build.
const windowIconPath = path.join(__dirname, '..', 'build', 'icon.png');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#FFFFFF', // avoids a flash of black before first paint
    autoHideMenuBar: true,
    ...(fs.existsSync(windowIconPath) ? { icon: windowIconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // renderer and preload run in separate JS worlds
      nodeIntegration: false, // renderer NEVER gets require()/Node access
      sandbox: false, // preload needs require('electron'); renderer itself stays sandboxed by contextIsolation
      webSecurity: true,
      spellcheck: false,
    },
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Wraps every IPC handler in one consistent envelope so the renderer
 * never has to guess whether it's dealing with a rejected promise, a
 * thrown Error, or a raw value: it always gets { success, data } or
 * { success: false, error }.
 */
function safeHandle(channel, handler) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const data = await handler(...args);
      return { success: true, data };
    } catch (err) {
      // Log full detail on the main-process side (visible in dev
      // tools / terminal), but only ever send the message string to
      // the renderer - never a raw stack trace or SQL text.
      console.error(`[IPC:${channel}]`, err);
      return { success: false, error: err.message || 'Unknown error' };
    }
  });
}

function registerIpcHandlers() {
  // ---------- Shifts ----------
  safeHandle(CH.SHIFT_OPEN, (payload) => shiftsRepo.openShift(payload));
  safeHandle(CH.SHIFT_CLOSE, (shiftId, payload) => shiftsRepo.closeShift(shiftId, payload));
  safeHandle(CH.SHIFT_AUTO_CLOSE, (shiftId) => shiftsRepo.autoCloseShift(shiftId));
  safeHandle(CH.SHIFT_GET_OPEN, () => shiftsRepo.getOpenShift());
  safeHandle(CH.SHIFT_LIST, (opts) => shiftsRepo.listShifts(opts));
  safeHandle(CH.SHIFT_GET_SALES_TOTAL, (shiftId) => shiftsRepo.getShiftSalesTotal(shiftId));

  // ---------- Items ----------
  safeHandle(CH.ITEM_LIST, (opts) => itemsRepo.listItems(opts));
  safeHandle(CH.ITEM_LIST_CATEGORIES, () => itemsRepo.listCategories());
  safeHandle(CH.ITEM_CREATE, ({ imageDataUrl, ...payload }) => {
    const item = itemsRepo.createItem(payload);
    if (!imageDataUrl) return item;
    // Image filename is keyed by item id, so the item must exist first.
    const imagePath = saveItemImage(userDataDir, item.id, imageDataUrl);
    return itemsRepo.setImage(item.id, imagePath);
  });
  safeHandle(CH.ITEM_UPDATE, (id, { imageDataUrl, removeImage, ...payload }) => {
    itemsRepo.updateItem(id, payload);
    if (imageDataUrl) {
      const imagePath = saveItemImage(userDataDir, id, imageDataUrl);
      return itemsRepo.setImage(id, imagePath);
    }
    if (removeImage) {
      const existing = itemsRepo.getItemById(id);
      deleteItemImage(userDataDir, existing?.image_path);
      return itemsRepo.setImage(id, null);
    }
    return itemsRepo.getItemById(id);
  });
  safeHandle(CH.ITEM_SET_AVAILABILITY, (id, isAvailable) => itemsRepo.setAvailability(id, isAvailable));
  safeHandle(CH.ITEM_DELETE, (id) => {
    const existing = itemsRepo.getItemById(id);
    itemsRepo.deleteItem(id);
    deleteItemImage(userDataDir, existing?.image_path);
    return true;
  });
  safeHandle(CH.ITEM_REORDER, (orderedIds) => itemsRepo.reorderItems(orderedIds));
  safeHandle(CH.ITEM_UPLOAD_IMAGE, (id, dataUrl) => {
    const imagePath = saveItemImage(userDataDir, id, dataUrl);
    return itemsRepo.setImage(id, imagePath);
  });
  safeHandle(CH.ITEM_GET_IMAGE, (relativePath) => getItemImageDataUrl(userDataDir, relativePath));
  safeHandle(CH.ITEM_RENAME_CATEGORY, (oldName, newName) => itemsRepo.renameCategory(oldName, newName));
  safeHandle(CH.ITEM_DELETE_CATEGORY, (categoryName, options) => itemsRepo.deleteCategory(categoryName, options));
  safeHandle(CH.SEED_GALLERY_LIST, () => seedGallery.listGallery());
  safeHandle(CH.SEED_GALLERY_GET_IMAGE, (category, filename) => seedGallery.getGalleryImageDataUrl(category, filename));
  safeHandle(CH.CUSTOM_GALLERY_LIST, () => customGallery.listImages(userDataDir));
  safeHandle(CH.CUSTOM_GALLERY_CATEGORIES, () => customGallery.listCategories(userDataDir));
  safeHandle(CH.CUSTOM_GALLERY_ADD, (name, category, dataUrl) => customGallery.addImage(userDataDir, name, category, dataUrl));
  safeHandle(CH.CUSTOM_GALLERY_GET_IMAGE, (filename) => customGallery.getImageDataUrl(userDataDir, filename));
  safeHandle(CH.CUSTOM_GALLERY_DELETE, (filename) => {
    customGallery.deleteImage(userDataDir, filename);
    return true;
  });

  // ---------- Orders ----------
  safeHandle(CH.ORDER_CREATE, (payload) => ordersRepo.createOrder(payload));
  safeHandle(CH.ORDER_GET, (orderId) => ordersRepo.getOrderWithItems(orderId));
  safeHandle(CH.ORDER_LIST_RECENT, (opts) => ordersRepo.listRecentOrders(opts));
  safeHandle(CH.ORDER_LIST_BY_RANGE, (opts) => ordersRepo.listOrdersByDateRange(opts));
  safeHandle(CH.ORDER_LIST_BY_CUSTOMER, (customerId, opts) => ordersRepo.listOrdersByCustomer(customerId, opts));
  safeHandle(CH.ORDER_VOID, (orderId) => ordersRepo.voidOrder(orderId));
  safeHandle(CH.ORDER_DANGER_COUNT, (opts) => ordersRepo.countOrdersInRange(opts));
  safeHandle(CH.ORDER_DANGER_DELETE, (opts) => ordersRepo.deleteOrdersInRange(opts));
  safeHandle(CH.ORDER_LIST_DELETED, (opts) => ordersRepo.listDeletedOrders(opts));
  safeHandle(CH.ORDER_HARD_DELETE, (orderIds) => ordersRepo.permanentlyDeleteOrders(orderIds));

  // ---------- Customers (secured - renderer-side route guard still required) ----------
  safeHandle(CH.CUSTOMER_LIST, (opts) => customersRepo.listCustomers(opts));
  safeHandle(CH.CUSTOMER_UPSERT, (payload) => customersRepo.upsertCustomer(payload));
  safeHandle(CH.CUSTOMER_UPDATE, (customerId, payload) => customersRepo.updateCustomer(customerId, payload));
  safeHandle(CH.CUSTOMER_DELETE, (customerId) => customersRepo.deleteCustomer(customerId));
  safeHandle(CH.CUSTOMER_ADD_ADDRESS, (customerId, payload) => customersRepo.addAddress(customerId, payload));
  safeHandle(CH.CUSTOMER_GET, (customerId) => customersRepo.getCustomerWithAddresses(customerId));
  safeHandle(CH.CUSTOMER_GET_STATS, (customerId) => customersRepo.getCustomerStats(customerId));
  safeHandle(CH.CUSTOMER_LIST_DUPLICATES, () => customersRepo.findDuplicateCustomerGroups());

  // ---------- Security gatekeeper ----------
  safeHandle(CH.SECURITY_IS_CONFIGURED, () => securityRepo.isLockConfigured());
  safeHandle(CH.SECURITY_SET_LOCK, (payload) => {
    const config = securityRepo.setLock(payload);
    // never leak hashes/salts back to the renderer
    const { credential_hash, credential_salt, security_answer_hash, security_answer_salt, ...safe } = config;
    return safe;
  });
  safeHandle(CH.SECURITY_CLEAR_LOCK, () => securityRepo.clearLock());
  safeHandle(CH.SECURITY_VERIFY, (candidate) => securityRepo.verifyCredential(candidate));
  safeHandle(CH.SECURITY_GET_QUESTION, () => securityRepo.getSecurityQuestion());
  safeHandle(CH.SECURITY_VERIFY_ANSWER, (candidate) => securityRepo.verifySecurityAnswer(candidate));
  safeHandle(CH.SECURITY_GET_LOCK_TYPE, () => securityRepo.getLockType());
  safeHandle(CH.SECURITY_GET_RECOVERY_CHALLENGE, () => generateChallenge(machineId).challenge);
  safeHandle(CH.SECURITY_VERIFY_MASTER_KEY, (candidateKey) => {
    const ok = verifyMasterKey(machineId, candidateKey);
    if (ok) securityRepo.clearLock(); // force a fresh lock to be set right after recovery
    return ok;
  });

  // ---------- Settings ----------
  safeHandle(CH.SETTINGS_GET_ALL, () => settingsRepo.getAllSettings());
  safeHandle(CH.SETTINGS_SET, (entries) => {
    const result = settingsRepo.setSettings(entries);
    // Settings (including which printer is selected) just changed - drop
    // any cached auto-detected paper width so the next print re-detects
    // rather than reusing a width that belonged to a previously-selected
    // printer. This runs at most once per Settings save, not per print,
    // so the small PowerShell cost on the next print is a non-issue.
    invalidatePaperWidthCache();
    return result;
  });

  // ---------- Printer ----------
  safeHandle(CH.PRINTER_PRINT_RECEIPT, (orderId) => printReceipt(orderId));
  safeHandle(CH.PRINTER_GET_RECEIPT_HTML, (orderId) => buildReceiptHtmlForOrder(orderId));
  safeHandle(CH.PRINTER_LIST_PRINTERS, async () => {
    if (!mainWindow) return [];
    // Real Electron API: asks Windows (or whatever OS) for every
    // printer it currently has installed, by name - this is what lets
    // Settings offer a picker instead of the admin typing an exact
    // printer name from memory.
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
  });

  // ---------- Analytics ----------
  safeHandle(CH.ANALYTICS_GET_SUMMARY, (range) => analyticsRepo.getSummary(range));
  safeHandle(CH.ANALYTICS_GET_DELETED_SUMMARY, (range) => analyticsRepo.getDeletedSummary(range));

  // ---------- WhatsApp Bulk Deal Sender ----------
  // initClient()/logout() are idempotent from the renderer's point of
  // view - the Connect button can be clicked repeatedly without side
  // effects, and the real progress always arrives via the push-only
  // 'whatsapp:event' channel rather than the invoke's return value.
  safeHandle(CH.WHATSAPP_INIT, () => whatsappService.initClient(userDataDir));
  safeHandle(CH.WHATSAPP_GET_STATUS, () => whatsappService.getStatus());
  safeHandle(CH.WHATSAPP_GET_LOGS, () => whatsappService.getLogs());
  safeHandle(CH.WHATSAPP_LOGOUT, () => whatsappService.logout());
  safeHandle(CH.WHATSAPP_GET_CAMPAIGN_STATE, () => whatsappService.getCampaignState());
  safeHandle(CH.WHATSAPP_START_CAMPAIGN, (payload) => whatsappService.startCampaign(payload));
  safeHandle(CH.WHATSAPP_RESUME_CAMPAIGN, () => whatsappService.resumeCampaign());
  safeHandle(CH.WHATSAPP_RETRY_FAILED, () => whatsappService.retryFailedCampaign());
  safeHandle(CH.WHATSAPP_STOP_CAMPAIGN, () => whatsappService.stopCampaign());
  safeHandle(CH.WHATSAPP_NEW_CAMPAIGN, () => whatsappService.newCampaign());

  // ---------- WhatsApp Deal Sender: saved templates ----------
  // Mirrors the ITEM_CREATE / ITEM_UPDATE image-handling pattern above:
  // the DB row is created/updated first, then the (optional) image is
  // written to disk keyed by the now-known row id.
  safeHandle(CH.WHATSAPP_TEMPLATE_LIST, () => whatsappMarketingRepo.listTemplates());
  safeHandle(CH.WHATSAPP_TEMPLATE_CREATE, ({ imageDataUrl, ...payload }) => {
    const template = whatsappMarketingRepo.createTemplate(payload);
    if (!imageDataUrl) return template;
    const imagePath = saveTemplateImage(userDataDir, template.id, imageDataUrl);
    return whatsappMarketingRepo.setTemplateImage(template.id, imagePath);
  });
  safeHandle(CH.WHATSAPP_TEMPLATE_UPDATE, (id, { imageDataUrl, removeImage, ...payload }) => {
    whatsappMarketingRepo.updateTemplate(id, payload);
    if (imageDataUrl) {
      const imagePath = saveTemplateImage(userDataDir, id, imageDataUrl);
      return whatsappMarketingRepo.setTemplateImage(id, imagePath);
    }
    if (removeImage) {
      const existing = whatsappMarketingRepo.getTemplateById(id);
      deleteItemImage(userDataDir, existing?.image_path);
      return whatsappMarketingRepo.setTemplateImage(id, null);
    }
    return whatsappMarketingRepo.getTemplateById(id);
  });
  safeHandle(CH.WHATSAPP_TEMPLATE_DELETE, (id) => {
    const existing = whatsappMarketingRepo.getTemplateById(id);
    whatsappMarketingRepo.deleteTemplate(id);
    deleteItemImage(userDataDir, existing?.image_path);
    return true;
  });

  // Generic relative-path -> data URL resolver (works for both
  // item-images/ and deal-images/ since it just joins userDataDir).
  safeHandle(CH.WHATSAPP_IMAGE_GET, (relativePath) => getItemImageDataUrl(userDataDir, relativePath));
}

app.whenReady().then(() => {
  userDataDir = app.getPath('userData');
  initDatabase(userDataDir);
  seedMenuIfEmpty(itemsRepo);
  backfillMissingUrduNames(itemsRepo);
  machineId = getOrCreateMachineId(userDataDir);
  registerIpcHandlers();
  createWindow();

  // Every WhatsApp status/progress event is pushed to whichever window
  // is currently open. If the window is ever recreated (macOS-style
  // activate flow) this still points at the live instance because it
  // re-reads `mainWindow` on every call rather than capturing it once.
  whatsappService.setEventSink((payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(CH.WHATSAPP_EVENT, payload);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  // Windows/Linux: quit fully. (macOS convention of staying resident
  // doesn't matter here since this ships as a Windows .exe.)
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  closeDatabase();
  whatsappService.stopCampaign();
  whatsappService.flushCampaignState();
});
