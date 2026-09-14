'use strict';

/**
 * WhatsApp Bulk Deal Sender - main-process service.
 *
 * Runs entirely in the main process (never in the renderer) because it
 * drives a real headless Chromium instance via whatsapp-web.js/Puppeteer.
 * The renderer only ever sees plain-JSON status events pushed over
 * `whatsapp:event` and issues plain commands (init / start / stop /
 * retry / new-campaign) - it never touches whatsapp-web.js or
 * Puppeteer directly.
 *
 * DESIGN NOTES
 * ------------
 * 1. Single shared Client instance, lazily created on first `init()`
 *    call and kept alive for the app's lifetime (or until logout) so
 *    the operator only scans the QR code once, ever - LocalAuth
 *    persists the session to disk under userData/whatsapp-session.
 * 2. One campaign session at a time, held by `campaignStore` (a plain
 *    in-memory object mirrored to a JSON snapshot on disk - NOT a
 *    database table, and NOT "history": it's a single overwritten
 *    session that only exists between "New Campaign" clicks).
 * 3. The full selected contact list is split into groups of 15
 *    (campaignStore.CONTACTS_PER_GROUP). Groups are sent with a random
 *    6-15 minute gap between them; contacts within a group are sent
 *    with a random few-seconds gap between them. Both are randomized
 *    (not a fixed interval) specifically so the traffic pattern
 *    doesn't look automated.
 * 4. Every emitted event is a plain object - no Error instances,
 *    no class instances, nothing that would fail structured-clone
 *    across the IPC boundary.
 */

const path = require('path');
const fs = require('fs');
const dns = require('dns');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');
const QRCode = require('qrcode');
const campaignStore = require('./campaignStore');

// ---- Anti-ban tuning -------------------------------------------------
// Gap between two contacts inside the SAME group of 15.
const CONTACT_MIN_DELAY_MS = 8 * 1000;
const CONTACT_MAX_DELAY_MS = 25 * 1000;
// Gap between one group of 15 finishing and the next one starting.
const GROUP_MIN_DELAY_MS = 6 * 60 * 1000;
const GROUP_MAX_DELAY_MS = 15 * 60 * 1000;
// How often the "waiting between groups" sleep wakes up to check
// whether Stop was pressed - keeps Stop feeling instant instead of
// making the operator wait out up to 15 minutes.
const WAIT_POLL_MS = 2000;

// ---- Connectivity tuning ----------------------------------------------
const DNS_PROBE_HOSTNAME = 'www.google.com';
const RECONNECT_POLL_MS = 5000;

/** @type {import('whatsapp-web.js').Client | null} */
let client = null;

/** 'DISCONNECTED' | 'INITIALIZING' | 'QR' | 'AUTHENTICATED' | 'READY' | 'AUTH_FAILURE' | 'RECONNECTING' */
let clientStatus = 'DISCONNECTED';
let lastQrDataUrl = null;
let lastStatusMessage = null;

/** Rolling record of what actually happened to the WhatsApp connection,
 *  in plain language, newest first. Shown to the operator via a "View
 *  Logs" button instead of a single generic status line - if something
 *  isn't connecting, the real reason (a timeout, a rejected login, no
 *  internet, etc.) is right there instead of hidden in a devtools console
 *  no non-technical shop owner would ever open. Capped so it can't grow
 *  forever during a long-running session. */
const MAX_LOG_ENTRIES = 200;
let logEntries = [];

function logEvent(message) {
  if (!message) return;
  logEntries.unshift({ time: new Date().toISOString(), message: String(message) });
  if (logEntries.length > MAX_LOG_ENTRIES) logEntries.length = MAX_LOG_ENTRIES;
}

function getLogs() {
  return logEntries.slice();
}

/** Set once by main.js so this module can push events without owning a BrowserWindow reference. */
let pushEvent = () => {};

/** True while runCampaignQueue()'s loop is actively executing (as
 *  opposed to campaignStore.getState() just having leftover data from
 *  a previous, now-paused/completed session). */
let loopRunning = false;
/** Set true to make the current loop exit at its next check point. */
let stopRequested = false;

/** Set once by initClient() so a saved template's stored relative image
 *  path (e.g. "deal-images/template-7.jpg") can be resolved to a real
 *  absolute path when a campaign is started from a template. */
let userDataDirRef = null;

function setEventSink(fn) {
  pushEvent = typeof fn === 'function' ? fn : () => {};
}

function emit(type, payload = {}) {
  pushEvent({ type, ...payload });
}

function emitStatus(extra = {}) {
  emit('status', { status: clientStatus, qr: lastQrDataUrl, message: lastStatusMessage, ...extra });
}

/**
 * Async on purpose: if we currently believe we're READY, this does one
 * live client.getState() check before answering, so opening the
 * WhatsApp Deals page always reflects reality immediately rather than
 * potentially showing a stale "Connected" badge for up to
 * HEALTH_CHECK_INTERVAL_MS until the next periodic check catches it.
 */
async function getStatus() {
  if (client && clientStatus === 'READY') {
    let state = null;
    try {
      state = await client.getState();
    } catch (err) {
      state = null;
    }
    if (state !== 'CONNECTED') {
      handleDisconnect(state ? `Session state changed to ${state}` : 'Lost contact with the WhatsApp session');
    }
  }
  return { status: clientStatus, qr: lastQrDataUrl, message: lastStatusMessage, campaignActive: loopRunning };
}

/** Node-native connectivity probe - no extra dependency, works fully offline-first. */
function checkInternet() {
  return new Promise((resolve) => {
    dns.lookup(DNS_PROBE_HOSTNAME, (err) => resolve(!err));
  });
}

/** Polls every RECONNECT_POLL_MS until the DNS probe succeeds again. */
async function waitForInternet(onStillDown) {
  // eslint-disable-next-line no-await-in-loop
  while (!(await checkInternet())) {
    onStillDown();
    // eslint-disable-next-line no-await-in-loop
    await sleep(RECONNECT_POLL_MS);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleeps `ms`, but wakes up every WAIT_POLL_MS to check stopRequested,
 *  so a 6-15 minute inter-group wait can still be cancelled promptly. */
async function interruptibleSleep(ms) {
  let remaining = ms;
  while (remaining > 0 && !stopRequested) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(Math.min(WAIT_POLL_MS, remaining));
    remaining -= WAIT_POLL_MS;
  }
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Injects the customer's first name at the start of the message so no
 * two outgoing payloads are byte-identical (a major spam-filter
 * trigger for bulk senders). If the template already contains a
 * `{name}` placeholder that is used instead of prepending a greeting,
 * so an admin who wrote their own greeting isn't double-greeted.
 */
function personalizeMessage(template, customerName) {
  const firstName = String(customerName || '').trim().split(/\s+/)[0] || 'Customer';
  if (template.includes('{name}')) {
    return template.split('{name}').join(firstName);
  }
  return `Salam ${firstName} Sb! ${template}`;
}

/**
 * Normalizes a locally-stored phone number into a WhatsApp chat id.
 * Handles the common Pakistani formats this POS's Customers module
 * actually stores (03XXXXXXXXX, +923XXXXXXXXX, 923XXXXXXXXX).
 */
function toWhatsAppChatId(rawPhone) {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0')) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10) digits = `92${digits}`; // bare 3XXXXXXXXX
  return `${digits}@c.us`;
}

/** setInterval handle for the periodic "are we ACTUALLY still connected"
 *  check - see startHealthCheck() for why this exists. */
let healthCheckTimer = null;
const HEALTH_CHECK_INTERVAL_MS = 20000;

function stopHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

/**
 * whatsapp-web.js's own 'disconnected' event is NOT fully reliable -
 * if the phone loses internet, the session gets logged out from
 * another device, or WhatsApp's servers silently drop the socket, the
 * library can fail to fire 'disconnected' at all, leaving the app
 * showing a stale "Connected" badge indefinitely even though nothing
 * will actually send. This periodic check calls the library's own
 * client.getState() - which asks the real WhatsApp Web page what its
 * connection state actually is right now - and treats anything other
 * than the literal 'CONNECTED' string (including a thrown error, e.g.
 * because the underlying browser tab died) as a real disconnect, so
 * the UI is corrected within HEALTH_CHECK_INTERVAL_MS instead of
 * silently lying to the cashier.
 */
function startHealthCheck() {
  stopHealthCheck();
  healthCheckTimer = setInterval(async () => {
    if (!client || clientStatus !== 'READY') return;
    let state = null;
    try {
      state = await client.getState();
    } catch (err) {
      state = null; // the page/browser is gone - definitely not connected
    }
    if (state !== 'CONNECTED') {
      handleDisconnect(state ? `Session state changed to ${state}` : 'Lost contact with the WhatsApp session');
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/** Single source of truth for tearing down a dead session, called
 *  from BOTH the library's 'disconnected' event and the health check
 *  above - whichever notices first. Idempotent: safe to call more
 *  than once (e.g. if both fire around the same moment). */
function handleDisconnect(reason) {
  if (!client) return; // already handled
  stopHealthCheck();
  clientStatus = 'DISCONNECTED';
  lastQrDataUrl = null;
  lastStatusMessage = reason ? `Disconnected: ${reason}` : 'Disconnected.';
  logEvent(lastStatusMessage);
  if (loopRunning) requestStop();
  const deadClient = client;
  client = null; // so initClient() builds a fresh one instead of reusing a dead page
  emitStatus();
  // Best-effort cleanup of the dead browser session - failures here are
  // expected (the page is often already gone) and safe to ignore.
  deadClient.destroy().catch(() => {});
}

/** Finds the Chromium executable Puppeteer downloaded, and fails fast
 *  with a clear log line instead of a cryptic "spawn ENOENT" if it's
 *  missing - the #1 real-world cause of "connects on my computer, fails
 *  on the installed copy": the browser was never bundled into the .exe.
 *  @returns {string|null} absolute path, or null if nothing was found. */
function resolveChromeExecutablePath() {
  try {
    const resolved = puppeteer.executablePath();
    if (resolved && fs.existsSync(resolved)) return resolved;
    logEvent(
      `Could not find the Chrome browser WhatsApp needs (looked for it at "${resolved || 'unknown path'}"). ` +
        `This copy of the app was built without it bundled in - reinstall the latest version of the app.`
    );
  } catch (err) {
    logEvent(`Could not locate the Chrome browser WhatsApp needs: ${err.message}`);
  }
  return null;
}

/** Turns raw Puppeteer/Chromium error text into a plain-language line a
 *  non-technical shop owner (or whoever's reading the logs on their
 *  behalf) can actually act on, instead of a stack-trace-flavoured
 *  string like "spawn ... ENOENT" or "net::ERR_INTERNET_DISCONNECTED". */
function friendlyLaunchErrorMessage(err) {
  const raw = String(err && err.message ? err.message : err || '');
  if (/ENOENT|Failed to launch|executablePath/i.test(raw)) {
    return 'Could not start the WhatsApp session - the Chrome browser it needs is missing or blocked on this computer.';
  }
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|net::ERR/i.test(raw)) {
    return 'Could not start the WhatsApp session - no internet connection.';
  }
  if (/EACCES|permission denied/i.test(raw)) {
    return 'Could not start the WhatsApp session - blocked by Windows/antivirus permissions.';
  }
  if (/timeout/i.test(raw)) {
    return 'Could not start the WhatsApp session - it took too long to start. Try again.';
  }
  return raw || 'Could not start the WhatsApp session.';
}

function initClient(userDataDir) {
  userDataDirRef = userDataDir;
  campaignStore.init(userDataDir);
  if (client) return getStatus();

  clientStatus = 'INITIALIZING';
  lastStatusMessage = 'Starting WhatsApp session...';
  logEvent(lastStatusMessage);
  emitStatus();

  const chromeExecutablePath = resolveChromeExecutablePath();
  if (!chromeExecutablePath) {
    clientStatus = 'AUTH_FAILURE';
    lastStatusMessage = 'Could not start WhatsApp - the Chrome browser it needs is missing from this install.';
    emitStatus();
    return getStatus();
  }

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(userDataDir, 'whatsapp-session'),
    }),
    puppeteer: {
      headless: true,
      executablePath: chromeExecutablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', async (qr) => {
    clientStatus = 'QR';
    lastStatusMessage = 'Scan this code with WhatsApp on your phone.';
    logEvent(lastStatusMessage);
    try {
      lastQrDataUrl = await QRCode.toDataURL(qr);
    } catch (err) {
      lastQrDataUrl = null;
      logEvent(`Could not generate the QR code image: ${err.message}`);
    }
    emitStatus();
  });

  client.on('authenticated', () => {
    clientStatus = 'AUTHENTICATED';
    lastQrDataUrl = null;
    lastStatusMessage = 'Signed in - finishing setup...';
    logEvent(lastStatusMessage);
    emitStatus();
  });

  client.on('auth_failure', (msg) => {
    clientStatus = 'AUTH_FAILURE';
    lastQrDataUrl = null;
    lastStatusMessage = msg || 'Authentication failed. Try connecting again.';
    logEvent(`Authentication failed: ${lastStatusMessage}`);
    emitStatus();
  });

  client.on('ready', () => {
    clientStatus = 'READY';
    lastQrDataUrl = null;
    lastStatusMessage = 'Connected.';
    logEvent('Connected successfully.');
    emitStatus();
    startHealthCheck();
  });

  client.on('disconnected', (reason) => {
    handleDisconnect(reason);
  });

  client.initialize().catch((err) => {
    clientStatus = 'AUTH_FAILURE';
    lastStatusMessage = friendlyLaunchErrorMessage(err);
    logEvent(`Could not start the session: ${lastStatusMessage} (${err && err.message ? err.message : err})`);
    emitStatus();
  });

  return getStatus();
}

async function logout() {
  stopHealthCheck();
  if (!client) {
    clientStatus = 'DISCONNECTED';
    lastQrDataUrl = null;
    return true;
  }
  if (loopRunning) requestStop();
  try {
    await client.logout();
  } catch (err) {
    // Session may already be invalid server-side - fine, we're tearing it down anyway.
  }
  try {
    await client.destroy();
  } catch (err) {
    // Ignore - already gone.
  }
  client = null;
  clientStatus = 'DISCONNECTED';
  lastQrDataUrl = null;
  lastStatusMessage = 'Logged out.';
  logEvent(lastStatusMessage);
  emitStatus();
  return true;
}

/** Returns the persisted session (sent/remaining/failed groups, or
 *  null if "New Campaign" was clicked / nothing has been sent yet). */
function getCampaignState() {
  return campaignStore.getState();
}

/**
 * @param {object} payload
 * @param {Array<{id:number|string, name:string, phone:string}>} payload.contacts - the full "Send All" list, any size
 * @param {string} payload.message - template text, may contain "{name}"
 * @param {string|null} payload.imagePath - absolute local filesystem path to the deal image, or null for text-only
 * @param {string|null} payload.imageRelativePath - path relative to userData (e.g. a saved
 *   template's "deal-images/template-7.jpg") - used instead of imagePath when the image
 *   came from a saved template rather than a freshly-picked file.
 */
async function startCampaign({ contacts, message, imagePath, imageRelativePath } = {}) {
  // Re-verify live, not just the cached flag - otherwise a campaign
  // could be "started" against a session that died silently between
  // health checks, and every single send would then fail one by one.
  const freshStatus = await getStatus();
  if (freshStatus.status !== 'READY') {
    throw new Error('WhatsApp is not connected. Scan the QR code first.');
  }
  if (loopRunning) {
    throw new Error('A campaign is already running. Stop it before starting a new one.');
  }
  if (!Array.isArray(contacts) || contacts.length === 0) {
    throw new Error('Select at least one customer.');
  }
  if (!message || !message.trim()) {
    throw new Error('Write the deal message first.');
  }
  const invalidContact = contacts.find((c) => !toWhatsAppChatId(c.phone));
  if (invalidContact) {
    throw new Error(`"${invalidContact.name}" has no usable phone number.`);
  }

  const resolvedImagePath = resolveImagePath(imagePath, imageRelativePath);
  const media = loadMedia(resolvedImagePath);

  campaignStore.newCampaign({ message, imagePath: resolvedImagePath, imageRelativePath, contacts });
  const state = campaignStore.getState();

  emit('campaign-start', { totalGroups: state.groups.length, totalContacts: contacts.length });
  runQueue(media).catch((err) => {
    logEvent(`Campaign stopped: ${err.message || 'unexpected error'}`);
    emit('campaign-error', { message: err.message || 'The campaign stopped unexpectedly.' });
    campaignStore.setRunState('stopped');
    loopRunning = false;
  });

  return { started: true, totalGroups: state.groups.length, totalContacts: contacts.length };
}

/** Resumes a paused session (app was restarted, or Stop was pressed)
 *  from exactly where it left off, using the same message/image. */
async function resumeCampaign() {
  const freshStatus = await getStatus();
  if (freshStatus.status !== 'READY') {
    throw new Error('WhatsApp is not connected. Scan the QR code first.');
  }
  if (loopRunning) {
    throw new Error('The campaign is already running.');
  }
  const state = campaignStore.getState();
  if (!state) {
    throw new Error('There is no paused campaign to resume.');
  }
  const media = loadMedia(state.imagePath);
  campaignStore.setRunState('running');
  emit('campaign-start', { totalGroups: state.groups.length, totalContacts: state.groups.flat().length, resumed: true });
  runQueue(media).catch((err) => {
    logEvent(`Campaign stopped: ${err.message || 'unexpected error'}`);
    emit('campaign-error', { message: err.message || 'The campaign stopped unexpectedly.' });
    campaignStore.setRunState('stopped');
    loopRunning = false;
  });
  return { resumed: true };
}

/** Requeues every currently-failed contact as a fresh trailing group
 *  and resumes the loop just for them - "Retry failed". */
async function retryFailedCampaign() {
  const freshStatus = await getStatus();
  if (freshStatus.status !== 'READY') {
    throw new Error('WhatsApp is not connected. Scan the QR code first.');
  }
  if (loopRunning) {
    throw new Error('A campaign is already running.');
  }
  const state = campaignStore.getState();
  if (!state) {
    throw new Error('There is no campaign to retry.');
  }
  const startIndex = campaignStore.requeueFailed();
  if (startIndex === null) {
    throw new Error('Nothing failed - there is nothing to retry.');
  }
  const media = loadMedia(state.imagePath);
  const failedCount = campaignStore.getState().groups[startIndex]
    ? campaignStore.getState().groups.slice(startIndex).flat().length
    : 0;
  emit('campaign-start', { totalGroups: campaignStore.getState().groups.length, totalContacts: failedCount, retrying: true });
  runQueue(media).catch((err) => {
    logEvent(`Retry stopped: ${err.message || 'unexpected error'}`);
    emit('campaign-error', { message: err.message || 'The retry stopped unexpectedly.' });
    campaignStore.setRunState('stopped');
    loopRunning = false;
  });
  return { retrying: true, count: failedCount };
}

/** Deletes the current session entirely - "New Campaign". Refuses
 *  while a send is actively in progress; Stop it first. */
function newCampaign() {
  if (loopRunning) {
    throw new Error('Stop the current campaign before starting a new one.');
  }
  campaignStore.clear();
  emit('campaign-cleared', {});
  return true;
}

function resolveImagePath(imagePath, imageRelativePath) {
  // A template's image is stored as a path relative to userData, since
  // absolute paths would break if the app's install location ever
  // changes. Resolve it to a real path only now, at send time.
  return imagePath || (imageRelativePath && userDataDirRef ? path.join(userDataDirRef, imageRelativePath) : null);
}

function loadMedia(resolvedImagePath) {
  if (!resolvedImagePath) return null;
  try {
    return MessageMedia.fromFilePath(resolvedImagePath);
  } catch (err) {
    throw new Error(`Could not read the deal image at "${resolvedImagePath}": ${err.message}`);
  }
}

function requestStop() {
  stopRequested = true;
}

/** Emergency stop - the in-flight send is allowed to finish, the loop
 *  exits before the next one (or the next inter-group wait) starts. */
function stopCampaign() {
  if (loopRunning) requestStop();
  return true;
}

/**
 * The queue engine. Walks campaignStore's groups starting at
 * currentGroupIndex/currentContactIndex (so resume/retry just have to
 * position the cursor before calling this), sending one contact at a
 * time with a random few-seconds gap, and waiting a random 6-15
 * minutes between groups.
 */
async function runQueue(media) {
  loopRunning = true;
  stopRequested = false;

  const state = campaignStore.getState();
  if (!state) {
    loopRunning = false;
    return;
  }

  for (let g = state.currentGroupIndex; g < state.groups.length; g += 1) {
    const group = state.groups[g];
    emit('group-start', { groupIndex: g, totalGroups: state.groups.length });

    const startContact = g === state.currentGroupIndex ? state.currentContactIndex : 0;
    for (let i = startContact; i < group.length; i += 1) {
      if (stopRequested) {
        campaignStore.setCursor(g, i);
        campaignStore.setRunState('stopped');
        emit('campaign-stopped', {});
        loopRunning = false;
        return;
      }

      const contact = group[i];
      // Already resolved on a previous pass (e.g. re-entering after a
      // resume) - don't re-send a contact that's already sent.
      if (contact.status === 'sent') continue;

      emit('contact-status', { groupIndex: g, contactId: contact.id, status: 'sending' });
      campaignStore.setContactStatus(g, contact.id, 'sending');

      // Pre-flight network check right before EVERY send, per spec -
      // not just once at the top of the loop, so a mid-campaign
      // outage is caught before the send that would otherwise throw.
      // eslint-disable-next-line no-await-in-loop
      const online = await checkInternet();
      if (!online) {
        clientStatus = 'RECONNECTING';
        lastStatusMessage = 'Internet Disconnected! Reconnecting...';
        logEvent(lastStatusMessage);
        emitStatus();
        emit('contact-status', { groupIndex: g, contactId: contact.id, status: 'pending' });
        campaignStore.setContactStatus(g, contact.id, 'pending');
        // eslint-disable-next-line no-await-in-loop
        await waitForInternet(() => emitStatus({ message: 'Internet Disconnected! Reconnecting...' }));
        if (stopRequested) {
          campaignStore.setCursor(g, i);
          campaignStore.setRunState('stopped');
          emit('campaign-stopped', {});
          loopRunning = false;
          return;
        }
        clientStatus = 'READY';
        lastStatusMessage = 'Back online - resuming campaign...';
        logEvent(lastStatusMessage);
        emitStatus();
      }

      try {
        const chatId = toWhatsAppChatId(contact.phone);
        const text = personalizeMessage(state.message, contact.name);
        if (media) {
          // eslint-disable-next-line no-await-in-loop
          await client.sendMessage(chatId, media, { caption: text });
        } else {
          // eslint-disable-next-line no-await-in-loop
          await client.sendMessage(chatId, text);
        }
        emit('contact-status', { groupIndex: g, contactId: contact.id, status: 'sent' });
        campaignStore.setContactStatus(g, contact.id, 'sent');
      } catch (err) {
        const errMessage = err.message || 'Send failed.';
        emit('contact-status', { groupIndex: g, contactId: contact.id, status: 'failed', error: errMessage });
        campaignStore.setContactStatus(g, contact.id, 'failed', errMessage);
      }

      campaignStore.setCursor(g, i + 1);

      const isLastContactOfLastGroup = g === state.groups.length - 1 && i === group.length - 1;
      if (!isLastContactOfLastGroup && !stopRequested) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(randomBetween(CONTACT_MIN_DELAY_MS, CONTACT_MAX_DELAY_MS));
      }
    }

    const groupSent = group.filter((c) => c.status === 'sent').length;
    const groupFailed = group.filter((c) => c.status === 'failed').length;
    emit('group-done', { groupIndex: g, sentCount: groupSent, failedCount: groupFailed });

    const isLastGroup = g === state.groups.length - 1;
    if (!isLastGroup && !stopRequested) {
      const waitMs = randomBetween(GROUP_MIN_DELAY_MS, GROUP_MAX_DELAY_MS);
      const resumeAt = new Date(Date.now() + waitMs).toISOString();
      campaignStore.setCursor(g + 1, 0);
      campaignStore.setNextGroupAt(resumeAt);
      emit('group-wait', { fromGroupIndex: g, toGroupIndex: g + 1, resumeAt });
      // eslint-disable-next-line no-await-in-loop
      await interruptibleSleep(waitMs);
      campaignStore.setNextGroupAt(null);
      if (stopRequested) {
        campaignStore.setRunState('stopped');
        emit('campaign-stopped', {});
        loopRunning = false;
        return;
      }
    }
  }

  const finalState = campaignStore.getState();
  const totalSent = finalState ? finalState.groups.flat().filter((c) => c.status === 'sent').length : 0;
  const totalFailed = finalState ? finalState.groups.flat().filter((c) => c.status === 'failed').length : 0;
  campaignStore.setRunState('completed');
  emit('campaign-done', { totalSent, totalFailed });
  loopRunning = false;
}

module.exports = {
  setEventSink,
  initClient,
  getStatus,
  getLogs,
  logout,
  getCampaignState,
  startCampaign,
  resumeCampaign,
  retryFailedCampaign,
  stopCampaign,
  newCampaign,
  flushCampaignState: campaignStore.flush,
  CONTACTS_PER_GROUP: campaignStore.CONTACTS_PER_GROUP,
  // exported for unit testing only
  _internal: { toWhatsAppChatId, personalizeMessage },
};
