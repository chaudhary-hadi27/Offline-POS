'use strict';

/**
 * Holds the ONE active/most-recent WhatsApp campaign "session" - no
 * SQL table, ever. This deliberately replaces the old
 * whatsapp_campaigns / whatsapp_campaign_recipients DB tables.
 *
 * Two copies of the same data are kept in sync:
 *  1. An in-memory object (`state`) - what the running send-loop
 *     reads/writes on every status change, zero I/O cost.
 *  2. A small JSON snapshot on disk (userData/whatsapp-campaign.json)
 *     - written so the sent/remaining/failed lists survive the app
 *     being closed and reopened, per spec: "hum software close kar k
 *     on kar lein records na jayein jub tak new campaign na click
 *     karein." This is NOT a database - it's a single overwritten
 *     snapshot, and "New Campaign" deletes it.
 *
 * Nothing here is kept "long term" - there is only ever one snapshot,
 * and it only exists between "New Campaign" clicks.
 *
 * WRITE STRATEGY: a single contact moving through the queue triggers
 * 2-3 state changes in quick succession (status -> 'sending', then
 * 'sent'/'failed', then the cursor advancing) - all within
 * milliseconds of each other. Re-serializing and rewriting the whole
 * (possibly large, for a big single-day campaign) JSON file for each
 * of those individually would be wasted work. Per-contact updates go
 * through a short debounce (schedulePersist) that coalesces a burst
 * like that into one write; campaign-level transitions that should be
 * durable immediately - a new campaign starting, "New Campaign"
 * clearing everything, Stop/Resume/Complete - go straight to disk
 * (persistNow). main.js flushes any pending debounced write on quit,
 * so nothing is ever lost on a clean exit.
 */

const fs = require('fs');
const path = require('path');

const CONTACTS_PER_GROUP = 15;
const FILE_NAME = 'whatsapp-campaign.json';
const PERSIST_DEBOUNCE_MS = 150;

let filePath = null;
/** @type {object|null} */
let state = null;
let persistTimer = null;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function writeToDisk() {
  if (!filePath) return; // init() not called yet - memory-only is still fine
  try {
    if (state) {
      fs.writeFileSync(filePath, JSON.stringify(state), 'utf8');
    } else if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    // Best-effort - a disk hiccup should never crash a send in progress.
    console.error('[whatsapp] failed to persist campaign snapshot', err);
  }
}

/** Immediate write - for transitions worth persisting right away. */
function persistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  writeToDisk();
}

/** Debounced write - coalesces the 2-3 rapid-fire updates a single
 *  contact's send generates into one disk write. The gap between one
 *  contact and the next is always 8-25 seconds (see whatsappService.js)
 *  - far longer than this debounce window - so nothing meaningful is
 *  ever at risk of being lost between "sending" and the write landing. */
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeToDisk();
  }, PERSIST_DEBOUNCE_MS);
}

/** Flushes any pending debounced write immediately - call this before
 *  the app quits so a clean exit never drops the last update. */
function flush() {
  if (persistTimer) persistNow();
}

/**
 * Call once at app boot. Loads whatever snapshot is on disk. If it was
 * mid-send when the app last closed, there is no loop actually running
 * anymore in this fresh process, so it's downgraded from 'running' to
 * 'stopped' (shown in the UI as "paused - resume sending") rather than
 * silently pretending nothing happened.
 */
function init(userDataDir) {
  filePath = path.join(userDataDir, FILE_NAME);
  try {
    if (fs.existsSync(filePath)) {
      state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (state && state.runState === 'running') {
        state.runState = 'stopped';
        state.nextGroupAt = null;
        persistNow();
      }
    }
  } catch (err) {
    console.error('[whatsapp] failed to load campaign snapshot, starting fresh', err);
    state = null;
  }
}

function getState() {
  return state;
}

/**
 * Starts a brand-new campaign, replacing whatever was there before.
 * Splits the full contact list into groups of 15 for the multi-group
 * "Send All" queue.
 */
function newCampaign({ message, imagePath, imageRelativePath, contacts }) {
  const groups = chunk(contacts, CONTACTS_PER_GROUP).map((group) =>
    group.map((c) => ({ id: c.id, name: c.name, phone: c.phone, status: 'pending', error: null, sentAt: null }))
  );
  state = {
    message,
    imagePath: imagePath || null,
    imageRelativePath: imageRelativePath || null,
    groups,
    currentGroupIndex: 0,
    currentContactIndex: 0,
    runState: 'running', // 'running' | 'stopped' | 'completed'
    nextGroupAt: null, // ISO timestamp - set while waiting between groups, for the countdown UI
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  persistNow();
  return state;
}

/** Clears the session entirely - the "New Campaign" button. */
function clear() {
  state = null;
  persistNow();
}

function setRunState(runState) {
  if (!state) return;
  state.runState = runState;
  if (runState === 'completed' || runState === 'stopped') state.nextGroupAt = null;
  if (runState === 'completed') state.finishedAt = new Date().toISOString();
  persistNow();
}

/** Called once per contact, right after every setContactStatus() -
 *  debounced along with it (see the write-strategy note above). */
function setCursor(groupIndex, contactIndex) {
  if (!state) return;
  state.currentGroupIndex = groupIndex;
  state.currentContactIndex = contactIndex;
  schedulePersist();
}

/** Called once per group transition (a handful of times per campaign,
 *  not a hotspot) - debounced anyway since a reload always discards
 *  this value regardless (init() drops it the moment it downgrades a
 *  'running' snapshot to 'stopped'), so there's nothing to protect by
 *  writing it any more urgently than the per-contact updates around it. */
function setNextGroupAt(iso) {
  if (!state) return;
  state.nextGroupAt = iso;
  schedulePersist();
}

/** The highest-frequency write in the whole module - fires twice per
 *  contact ('sending', then 'sent'/'failed'). Debounced. */
function setContactStatus(groupIndex, contactId, status, error = null) {
  if (!state || !state.groups[groupIndex]) return;
  const contact = state.groups[groupIndex].find((c) => c.id === contactId);
  if (!contact) return;
  contact.status = status;
  contact.error = error;
  if (status === 'sent' || status === 'failed') contact.sentAt = new Date().toISOString();
  schedulePersist();
}

/** Flat list of every failed contact across every group, for the Retry Failed button. */
function getFailedContacts() {
  if (!state) return [];
  return state.groups.flat().filter((c) => c.status === 'failed');
}

/**
 * Appends a fresh group made only of the currently-failed contacts,
 * reset to pending, and returns its index so the caller can resume the
 * send loop at exactly that group. Kept as its own trailing group (not
 * mutated in place) so the original groups still show what actually
 * happened on the first pass.
 */
function requeueFailed() {
  if (!state) return null;
  const failed = getFailedContacts();
  if (failed.length === 0) return null;
  const retryGroups = chunk(failed, CONTACTS_PER_GROUP).map((group) =>
    group.map((c) => ({ id: c.id, name: c.name, phone: c.phone, status: 'pending', error: null, sentAt: null }))
  );
  const startIndex = state.groups.length;
  state.groups.push(...retryGroups);
  state.currentGroupIndex = startIndex;
  state.currentContactIndex = 0;
  state.runState = 'running';
  state.finishedAt = null;
  persistNow();
  return startIndex;
}

module.exports = {
  CONTACTS_PER_GROUP,
  init,
  getState,
  newCampaign,
  clear,
  setRunState,
  setCursor,
  setNextGroupAt,
  setContactStatus,
  getFailedContacts,
  requeueFailed,
  flush,
};
