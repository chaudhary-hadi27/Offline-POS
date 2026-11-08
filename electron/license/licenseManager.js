'use strict';

/**
 * License state for the POS.
 *
 *   locked  = no license yet, license invalid for this PC, or expired.
 *             While locked, only Settings (and its Backup) work - the main
 *             process refuses every other IPC call (see main.js), so hiding
 *             buttons in the UI is not the only thing standing in the way.
 *   active  = valid signature, this PC's hardware id, not expired.
 *
 * THE POS KEEPS ITS OWN CALENDAR (T). The PC clock is never trusted - and
 * never allowed to hurt the customer either:
 *
 *   - T only moves FORWARD, by real running time (a monotonic timer that
 *     ignores the PC clock) plus the time the POS was switched off.
 *   - The time the POS was switched off is read from the PC clock, but at
 *     most MAX_GAP (7 days) is believed per event. So a clock typed into
 *     2035 moves T by 7 days at most, never by 9 years.
 *   - A clock put BACK moves T by the real running time only (so putting
 *     the clock back gains nothing, and nothing breaks).
 *   - When the PC clock agrees with T again (within 36h) it is simply
 *     adopted, so fixing a wrong date never causes any trouble: the POS
 *     just carries on.
 *   - A dead CMOS battery (PC boots in 2009), a wrong date, a fixed date:
 *     the POS keeps working in every case; the License tab shows both
 *     dates and a gentle note if they differ.
 *
 * The license itself carries a trusted time too: its issue date (iat) is
 * the vendor's real "now", so T is never allowed to be behind it. Each new
 * license (or repair code) therefore re-calibrates T.
 *
 * T is remembered in 3 places (two files + the Windows registry). Those copies are
 * plain data an administrator can edit, so they are NOT the only proof of time:
 * the newest order and the last backup time in the database are ALWAYS used as a
 * floor for T (when they are no more than 10 days ahead of the PC clock - an order
 * stamped years ahead came from a wrong clock and is ignored). Putting T back by
 * editing the saved copies therefore does nothing while the restaurant has orders:
 * to hide the real date the cheater would have to put the PC clock itself back
 * (which makes every receipt and report show a wrong date) or delete sales
 * history. Saved values that are corrupt (non-numbers, outside 2020-2100) are ignored rather than trusted, so a damaged file can never stop the
 * POS from starting. Beyond this, a determined person with admin rights can still
 * cheat - that is the honest limit of offline licensing (see docs/LICENSING_GUIDE.md).
 *
 * RENEWING. A newer license (later issue date) simply replaces the current
 * one - there is no moment without a license, the POS never locks in
 * between. An older key cannot replace a newer one.
 */

const { cleanKeyText, normalizeHardwareId, verifySigned, LICENSE_PREFIX, REPAIR_PREFIX } = require('./licenseFormat');

const DAY = 24 * 60 * 60 * 1000;
const MAX_GAP = 7 * DAY; // most "switched-off time" believed from the PC clock per event
const RECONCILE = 36 * 60 * 60 * 1000; // PC clock this close to T = the clock is fine, adopt it
const TOLERANCE = 2 * 60 * 1000; // normal drift between the PC clock and the monotonic timer
const EVIDENCE_WINDOW = 10 * DAY; // newest order/backup only counts if not further ahead of the PC clock than this
// Saved calendar dates outside this range are garbage (corruption / tampering). NOTE: the range is
// absolute on purpose - it must NOT be relative to the PC clock, because the PC clock itself may be
// wrong (dead CMOS battery => 2009) while the saved calendar is perfectly right.
const MIN_VALID_MS = Date.UTC(2020, 0, 1);
const MAX_VALID_MS = Date.UTC(2100, 0, 1);
const DIFF_WARN = 2 * DAY; // show a note when the PC date and the POS calendar differ by more than this
const PERSIST_STEP_MS = 15 * 60 * 1000; // how far T must advance before it is rewritten
const WARN_BEFORE_DAYS = 7;

const PLAN_LABELS = { M30: '30-day trial', Y01: '1 year', Y03: '3 years', Y10: '10 years', CUSTOM: 'Custom term' };

const REASON_MESSAGES = {
  malformed: 'That does not look like a valid license key. Copy the whole key, starting with POS1.',
  'unknown-key': 'This license was not signed with a key this POS version knows. Contact support.',
  'bad-signature': 'This license key is not valid (it was changed or is incomplete). Copy it again exactly as sent.',
  epoch: 'This license is for an older version of the POS. Contact support for a new key.',
};

function createLicenseManager(o) {
  const now = o.now || (() => Date.now());
  const mono = o.mono || (() => Number(process.hrtime.bigint() / 1000000n)); // monotonic ms, ignores the PC clock
  const log = o.log || (() => {});
  const stores = o.clockStores || [];
  const publicKeys = o.publicKeys || [];
  const minEpoch = o.minEpoch || 1;

  let hw = { id: '', source: 'file' };
  let payload = null; // verified license payload (or null)
  let invalid = null; // { reason, message } when a saved license is rejected
  let T = 0; // the POS's own calendar, epoch ms
  let sLast = 0; // PC clock reading at the last observation
  let monoLast = 0; // monotonic reading at the last observation
  let lastRepair = 0; // newest repair code applied (single use)
  let persistedT = 0;
  let cached = null;
  let timer = null;

  // ---------- the POS's own calendar ----------
  /** Move T forward to "now". Called every minute, at start-up and before every decision. */
  function advance() {
    const sys = now();
    const m = mono();
    const monoElapsed = Math.max(0, m - monoLast);
    const sysElapsed = sys - sLast;
    const candidate = T + monoElapsed;
    if (Math.abs(sys - candidate) <= RECONCILE) {
      T = Math.max(candidate, sys); // the clock agrees with us (again): adopt it
    } else if (sysElapsed - monoElapsed > TOLERANCE) {
      T = candidate + Math.min(sysElapsed - monoElapsed, MAX_GAP); // jumped / switched off: believe a bounded amount
    } else {
      T = candidate; // clock went back, or normal drift: only real running time counts
    }
    sLast = sys;
    monoLast = m;
    return T;
  }

  /** Cheap read of "now" for the per-request lock check (does not move the stored state). */
  const trustedNow = () => T + Math.max(0, mono() - monoLast);

  async function loadClockState() {
    const sys = now();
    const sane = (v) => Number.isFinite(v) && v >= MIN_VALID_MS && v <= MAX_VALID_MS;
    let best = null;
    for (const store of stores) {
      let rec = null;
      try {
        rec = await store.read();
      } catch (err) {
        log('[license] could not read a calendar copy', err);
      }
      if (!rec || typeof rec !== 'object') continue;
      if (Number.isFinite(rec.lastRepair) && rec.lastRepair >= 0) lastRepair = Math.max(lastRepair, rec.lastRepair);
      if (sane(rec.T) && (!best || rec.T > best.T)) best = { T: rec.T, S: sane(rec.S) ? rec.S : null };
    }
    monoLast = mono();
    T = best ? best.T : sys; // nothing usable saved: start from the PC clock
    sLast = best && best.S ? best.S : sys;
    await applyEvidence();
    advance(); // account for the time the POS was switched off
    persistedT = 0; // force the first write
  }

  /**
   * The newest order / backup time is proof that at least that much time has passed.
   * (Only if plausible: see EVIDENCE_WINDOW.) Orders cannot be edited away without
   * destroying the restaurant's own sales history.
   */
  async function applyEvidence() {
    const sys = now();
    for (const fn of [o.getLatestOrderMs, o.getBackupMs]) {
      if (!fn) continue;
      try {
        const v = await fn();
        if (Number.isFinite(v) && v <= sys + EVIDENCE_WINDOW) T = Math.max(T, v);
      } catch (err) {
        log('[license] evidence read failed', err);
      }
    }
  }

  async function persistClock() {
    persistedT = T;
    const rec = { T, S: sLast, lastRepair };
    await Promise.all(stores.map((st) => st.write(rec)));
  }

  /** The license's issue date is the vendor's real "now": T can never be behind it. */
  function calibrateFromLicense() {
    if (payload && Number.isFinite(payload.iat)) T = Math.max(T, payload.iat * 1000);
  }

  // ---------- license verification ----------
  function checkLicenseText(text) {
    const v = verifySigned(text, 'license', publicKeys);
    if (!v.ok) return { ok: false, reason: v.reason, message: REASON_MESSAGES[v.reason] };
    const p = v.payload;
    if (p.v !== 1 || !p.mid || !Number.isFinite(p.exp)) {
      return { ok: false, reason: 'malformed', message: REASON_MESSAGES.malformed };
    }
    if (normalizeHardwareId(p.mid) !== normalizeHardwareId(hw.id)) {
      return {
        ok: false,
        reason: 'wrong-machine',
        message: `This license was issued for a different PC (${p.mid}). This PC's Hardware ID is ${hw.id}. If you replaced the PC or reinstalled Windows, send the new Hardware ID to get a new key.`,
      };
    }
    if ((Number(p.epoch) || 0) < minEpoch) return { ok: false, reason: 'epoch', message: REASON_MESSAGES.epoch };
    return { ok: true, payload: p };
  }

  // ---------- status ----------
  function buildStatus() {
    const sys = now();
    const base = {
      hardwareId: hw.id,
      hardwareIdSource: hw.source,
      trustedNow: new Date(T).toISOString(),
      systemNow: new Date(sys).toISOString(),
      clockWarning: null,
      plan: null,
      planLabel: null,
      customer: null,
      issuedAt: null,
      expiresAt: null,
      daysLeft: null,
      expiringSoon: false,
    };
    if (Math.abs(sys - T) > DIFF_WARN) {
      base.clockWarning = `The PC date (${new Date(sys).toLocaleDateString()}) differs from the POS's own calendar (${new Date(T).toLocaleDateString()}). The POS keeps working and counts from its own calendar; please check the PC date (and the clock battery).`;
    }

    if (o.devBypass) {
      return { ...base, state: 'active', locked: false, plan: 'DEV', planLabel: 'Development (no license check)', message: 'License check is bypassed (development only).', _expMs: Infinity };
    }
    if (publicKeys.length === 0) {
      return { ...base, state: 'invalid', locked: true, message: 'The license system is not configured in this build (no public key). See docs/LICENSING_GUIDE.md.', _expMs: 0 };
    }
    if (invalid) {
      return { ...base, state: 'invalid', locked: true, message: invalid.message, _expMs: 0 };
    }
    if (!payload) {
      return { ...base, state: 'unlicensed', locked: true, message: 'Enter your license key to unlock the POS. Until then only Settings is available.', _expMs: 0 };
    }

    const expMs = payload.exp * 1000;
    const detail = {
      plan: payload.plan,
      planLabel: PLAN_LABELS[payload.plan] || payload.plan,
      customer: payload.cust || null,
      issuedAt: Number.isFinite(payload.iat) ? new Date(payload.iat * 1000).toISOString() : null,
      expiresAt: new Date(expMs).toISOString(),
    };
    if (T >= expMs) {
      return {
        ...base,
        ...detail,
        state: 'expired',
        locked: true,
        daysLeft: 0,
        message: 'This license has expired. Enter a new license key to continue. Your data is safe - Settings and Backup stay available. (The POS keeps its own calendar, so changing the PC date does not renew it.)',
        _expMs: expMs,
      };
    }
    const daysLeft = Math.max(1, Math.ceil((expMs - T) / DAY));
    return {
      ...base,
      ...detail,
      state: 'active',
      locked: false,
      daysLeft,
      expiringSoon: daysLeft <= WARN_BEFORE_DAYS,
      message: daysLeft <= WARN_BEFORE_DAYS ? `License expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Please renew.` : 'License is active.',
      _expMs: expMs,
    };
  }

  async function refresh() {
    advance();
    await applyEvidence();
    calibrateFromLicense();
    if (T - persistedT >= PERSIST_STEP_MS) await persistClock();
    cached = buildStatus();
    return publicStatus(cached);
  }

  const publicStatus = (s) => {
    const { _expMs, ...rest } = s;
    return rest;
  };

  // ---------- public API ----------
  async function init() {
    hw = await o.getHardwareId();
    await loadClockState();
    const text = o.licenseFiles ? await o.licenseFiles.load() : null;
    if (text) {
      const r = checkLicenseText(text);
      if (r.ok) payload = r.payload;
      else invalid = { reason: r.reason, message: r.message };
    }
    calibrateFromLicense();
    const status = await refresh();
    await persistClock(); // write the calendar to every store on first run
    return status;
  }

  async function activate(text) {
    const t = cleanKeyText(text);
    if (!t) throw new Error('Paste the license key first.');
    if (t.startsWith(REPAIR_PREFIX)) return applyRepair(t);
    if (!t.startsWith(LICENSE_PREFIX)) throw new Error('That does not look like a license key. It should start with POS1.');

    const r = checkLicenseText(t);
    if (!r.ok) throw new Error(r.message);
    advance();
    if (T >= r.payload.exp * 1000) throw new Error('This license has already expired. Ask for a new key.');
    // A key issued LATER replaces the current license at once - no gap, no lock.
    // An OLDER key can never replace a newer one (so a stale key can't be re-entered).
    if (payload && !invalid && (r.payload.iat || 0) < (payload.iat || 0)) {
      throw new Error('This key is older than the license already on this PC. Enter the newest key you were sent.');
    }
    if (o.licenseFiles) await o.licenseFiles.save(t);
    payload = r.payload;
    invalid = null;
    calibrateFromLicense();
    await persistClock();
    return refresh();
  }

  /** Vendor repair code: "the real date is X". Re-aligns the POS calendar (can move it either way). */
  async function applyRepair(t) {
    const v = verifySigned(t, 'repair', publicKeys);
    if (!v.ok) throw new Error('This repair code is not valid. Copy it again exactly as sent.');
    const p = v.payload;
    if (p.v !== 1 || p.type !== 'repair' || !Number.isFinite(p.now)) throw new Error('This repair code is not valid.');
    if (normalizeHardwareId(p.mid) !== normalizeHardwareId(hw.id)) throw new Error('This repair code is for a different PC.');
    const tokenNow = p.now * 1000;
    if (Math.abs(now() - tokenNow) > 2 * DAY) {
      throw new Error('Set the PC date and time correctly first, then enter the repair code again.');
    }
    if (tokenNow <= lastRepair) throw new Error('This repair code was already used.');
    lastRepair = tokenNow;
    T = tokenNow;
    sLast = now();
    monoLast = mono();
    calibrateFromLicense();
    await persistClock();
    return refresh();
  }

  /** Cheap, synchronous - called for every IPC request. */
  function isLocked() {
    if (o.devBypass) return false;
    if (!cached || cached.state !== 'active') return true;
    return trustedNow() >= cached._expMs;
  }

  function start(everyMs = 60 * 1000) {
    stop();
    timer = setInterval(() => refresh().catch((err) => log('[license] refresh failed', err)), everyMs);
    timer.unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { init, activate, getStatus: refresh, isLocked, start, stop, flush: persistClock };
}

/**
 * Channels that still work while the POS is locked: everything the Settings
 * page needs (settings, security lock, printers, Danger Zone, Backup) plus
 * the license screen itself. Everything else is refused in main.js.
 */
function isChannelAllowedWhenLocked(channel, CH) {
  const allowed = new Set([
    CH.SETTINGS_GET_ALL,
    CH.SETTINGS_SET,
    CH.PRINTER_LIST_PRINTERS,
    CH.ORDER_DANGER_COUNT,
    CH.ORDER_DANGER_DELETE,
    CH.LICENSE_GET_STATUS,
    CH.LICENSE_ACTIVATE,
  ]);
  if (allowed.has(channel)) return true;
  return /^(security|backup):/.test(String(channel));
}

module.exports = { createLicenseManager, isChannelAllowedWhenLocked, PLAN_LABELS };
