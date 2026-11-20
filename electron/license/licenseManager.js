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
 * RENEWING. A newer license (later issue date) of the SAME tier simply replaces the
 * current one - there is no moment without a license, the POS never locks in between.
 * An older key cannot replace a newer one.
 *
 * SEVERAL LICENSES ("wallet"). A PC can hold one Pro and one Premium license. Exactly one is
 * ACTIVE; the other is PAUSED and its remaining days are frozen (they only count while it is
 * active). Entering a higher-tier key starts it at once and pauses the lower one; entering a
 * lower-tier key just saves it. The customer can switch at any time (Settings > License), and
 * when the active license ends the paused one starts by itself. Pause time is measured with the
 * POS's own calendar (T), never with the PC clock, so pausing cannot be used to gain days:
 *     effective end = signed end + total time spent paused.
 * A key with "excl" (exclusive) removes every other license (refund / downgrade / replace-all).
 */

const crypto = require('crypto');
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
const HW_RETRY_MS = 3 * 60 * 1000; // how often to retry reading the OS machine id after a failed read
const MAX_PAUSED_MS = 3 * 365 * DAY; // sanity cap on the total paused time of one license (tamper guard)
const SLOTS = ['premium', 'pro']; // a PC holds at most one license per tier; this is the order they are preferred in
const keyId = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

const tiers = require('./tiers');

const PLAN_LABELS = { M30: '30-day trial', Y01: '1 year', Y03: '3 years', Y10: '10 years', CUSTOM: 'Custom term' };

const REASON_MESSAGES = {
  malformed: 'This is not a valid license key. Copy the full key, starting with POS1.',
  'unknown-key': 'This key is not recognised by this version. Contact support.',
  'bad-signature': 'This key is not valid. Copy it again exactly as sent.',
  epoch: 'This key is for an older version. Ask for a new key.',
};

function createLicenseManager(o) {
  const now = o.now || (() => Date.now());
  const mono = o.mono || (() => Number(process.hrtime.bigint() / 1000000n)); // monotonic ms, ignores the PC clock
  const log = o.log || (() => {});
  const stores = o.clockStores || [];
  const publicKeys = o.publicKeys || [];
  const minEpoch = o.minEpoch || 1;

  let hw = { id: '', source: 'file' };
  let payload = null; // payload of the ACTIVE license (or null) - kept in step with `slots` by sync()
  const slots = { premium: null, pro: null }; // the wallet: { text, id, payload, off, pausedAt } per tier
  let activeSlot = null; // which slot is running (it may be an expired one: then the POS is locked)
  let walletMeta = null; // saved pause bookkeeping, applied once the licenses are loaded
  let floors = {}; // per tier: keys issued before this moment are void (set by an exclusive key: refund / downgrade)
  let wv = 0; // wallet version: bumped on every change so the newest saved copy wins
  let notice = null; // one-line "what just happened" (auto switch), shown on the License tab
  let dirty = false; // wallet changed since the last write
  let invalid = null; // { reason, message } when saved licenses are all rejected
  let T = 0; // the POS's own calendar, epoch ms
  let sLast = 0; // PC clock reading at the last observation
  let monoLast = 0; // monotonic reading at the last observation
  let lastRepair = 0; // newest repair code applied (single use)
  let persistedT = 0;
  let cached = null;
  let timer = null;
  let savedText = null; // the licence text found on disk (kept so it can be re-checked)
  let lastHwRetry = 0;

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
      const w = rec.w;
      if (w && typeof w === 'object' && Number.isFinite(w.wv) && (!walletMeta || w.wv > walletMeta.wv)) walletMeta = w;
    }
    wv = walletMeta ? walletMeta.wv : 0;
    floors = {};
    if (walletMeta && walletMeta.f && typeof walletMeta.f === 'object') {
      for (const n of SLOTS) if (Number.isFinite(walletMeta.f[n]) && walletMeta.f[n] > 0) floors[n] = walletMeta.f[n];
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
    const s = {};
    for (const name of SLOTS) {
      const e = slots[name];
      if (e) s[name] = { i: e.id, o: e.off, p: e.pausedAt };
    }
    const rec = { T, S: sLast, lastRepair, w: { wv, a: activeSlot, s, f: floors } };
    dirty = false;
    await Promise.all(stores.map((st) => st.write(rec)));
  }

  /** The license's issue date is the vendor's real "now": T can never be behind it. */
  function calibrateFromLicense() {
    for (const name of SLOTS) {
      const e = slots[name];
      if (e && Number.isFinite(e.payload.iat)) T = Math.max(T, e.payload.iat * 1000);
    }
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
        message: `This key is for a different PC (${p.mid}). This PC's Hardware ID is ${hw.id}. Send it to us to get a new key.`,
      };
    }
    if ((Number(p.epoch) || 0) < minEpoch) return { ok: false, reason: 'epoch', message: REASON_MESSAGES.epoch };
    // "tier" is optional (keys issued before tiers existed) but, when present, must be a paid tier.
    if (p.tier !== undefined && !tiers.ISSUABLE_TIERS.includes(p.tier)) {
      return { ok: false, reason: 'malformed', message: REASON_MESSAGES.malformed };
    }
    return { ok: true, payload: p };
  }

  // ---------- the wallet: several licenses, one active ----------
  const tierOf = (p) => tiers.normalizeTier(p.tier) || tiers.LEGACY_TIER;
  const effExp = (e) => e.payload.exp * 1000 + e.off; // signed end + time spent paused
  /** Milliseconds this license still has. A paused license is frozen at its value on the day it was paused. */
  const remaining = (e) => (e.pausedAt != null ? effExp(e) - e.pausedAt : effExp(e) - T);
  const isExpired = (e) => remaining(e) <= 0;
  const hasAny = () => SLOTS.some((n) => slots[n]);
  const label = (n) => tiers.TIER_LABELS[n];
  const daysOf = (ms) => (ms <= 0 ? 0 : Math.max(1, Math.ceil(ms / DAY)));

  function sync() {
    payload = activeSlot && slots[activeSlot] ? slots[activeSlot].payload : null;
  }

  /** Total paused time can never exceed what is physically possible for this key. */
  function clampOffset(e, off) {
    const sinceIssue = Number.isFinite(e.payload.iat) ? Math.max(0, T - e.payload.iat * 1000) : MAX_PAUSED_MS;
    return Math.min(Math.max(0, Number(off) || 0), MAX_PAUSED_MS, sinceIssue);
  }

  /** The licence texts as they are stored: one plain key (readable by older builds) or a small JSON list. */
  function serializeWallet() {
    const keys = SLOTS.map((n) => slots[n] && slots[n].text).filter(Boolean);
    if (keys.length === 0) return '';
    return keys.length === 1 ? keys[0] : JSON.stringify({ v: 2, keys });
  }
  function parseWalletText(text) {
    const t = String(text || '').trim();
    if (!t) return [];
    if (t.startsWith('{')) {
      try {
        const j = JSON.parse(t);
        return Array.isArray(j.keys) ? j.keys.map(cleanKeyText).filter(Boolean) : [];
      } catch {
        return [];
      }
    }
    return [cleanKeyText(t)];
  }
  async function saveWallet() {
    if (!o.licenseFiles) return;
    const text = serializeWallet();
    if (text) await o.licenseFiles.save(text);
    else if (o.licenseFiles.clear) await o.licenseFiles.clear();
  }

  /** Read every saved key; keep the newest valid one per tier. If none is usable, remember why. */
  function loadWallet(text) {
    for (const n of SLOTS) slots[n] = null;
    invalid = null;
    let firstFail = null;
    for (const t of parseWalletText(text)) {
      const r = checkLicenseText(t);
      if (!r.ok) {
        firstFail = firstFail || r;
        continue;
      }
      const name = tierOf(r.payload);
      const cur = slots[name];
      if (cur && (cur.payload.iat || 0) >= (r.payload.iat || 0)) continue;
      slots[name] = { text: t, id: keyId(t), payload: r.payload, off: 0, pausedAt: null };
    }
    // An exclusive key voids older keys of the other tiers (also remembered across renewals in `floors`).
    for (const n of SLOTS) {
      const e = slots[n];
      if (e && e.payload.excl) for (const other of SLOTS) if (other !== n) floors[other] = Math.max(floors[other] || 0, e.payload.iat || 0);
    }
    for (const n of SLOTS) if (slots[n] && (slots[n].payload.iat || 0) < (floors[n] || 0)) slots[n] = null;
    if (!hasAny() && firstFail) invalid = { reason: firstFail.reason, message: firstFail.message };
  }

  /** Re-apply the saved pause bookkeeping to the freshly loaded licenses. */
  function applyWalletMeta() {
    const m = walletMeta;
    const saneT = (v) => Number.isFinite(v) && v >= MIN_VALID_MS && v <= MAX_VALID_MS;
    for (const n of SLOTS) {
      const e = slots[n];
      const rec = m && m.s && m.s[n];
      if (!e || !rec || rec.i !== e.id) continue; // bookkeeping only counts for the very same key
      e.off = clampOffset(e, rec.o);
      e.pausedAt = saneT(rec.p) ? Math.min(rec.p, T) : null;
    }
    activeSlot = m && typeof m.a === 'string' && slots[m.a] ? m.a : null;
  }

  /** Exactly one license is running; every other one is paused (its days frozen). */
  function normalizeWallet() {
    if (!activeSlot || !slots[activeSlot]) {
      const usable = SLOTS.find((n) => slots[n] && !isExpired(slots[n]));
      activeSlot = usable || SLOTS.filter((n) => slots[n]).sort((x, y) => effExp(slots[y]) - effExp(slots[x]))[0] || null;
    }
    for (const n of SLOTS) {
      const e = slots[n];
      if (!e) continue;
      if (n === activeSlot) {
        if (e.pausedAt != null) resumeEntry(e);
      } else if (e.pausedAt == null) {
        e.pausedAt = T;
      }
    }
    sync();
  }

  function resumeEntry(e) {
    if (e.pausedAt == null) return;
    e.off = clampOffset(e, e.off + Math.max(0, T - e.pausedAt));
    e.pausedAt = null;
  }

  /** Make `name` the running license and pause the current one. */
  function switchTo(name) {
    const target = slots[name];
    const cur = activeSlot && slots[activeSlot];
    if (cur && cur !== target && cur.pausedAt == null) cur.pausedAt = T;
    resumeEntry(target);
    activeSlot = name;
    wv += 1;
    dirty = true;
    sync();
  }

  /** The running license ended: start the other one (if it still has days). Returns true when it switched. */
  function fallbackIfEnded() {
    if (!activeSlot || !slots[activeSlot] || !isExpired(slots[activeSlot])) return false;
    const alt = SLOTS.find((n) => n !== activeSlot && slots[n] && !isExpired(slots[n]));
    if (!alt) return false;
    const from = activeSlot;
    switchTo(alt);
    notice = `${label(from)} has ended. ${label(alt)} started (${daysOf(remaining(slots[alt]))} days left).`;
    return true;
  }

  function licenseList() {
    return SLOTS.filter((n) => slots[n]).map((n) => {
      const e = slots[n];
      const current = n === activeSlot;
      const expired = isExpired(e);
      return {
        slot: n,
        tier: n,
        tierLabel: label(n),
        plan: e.payload.plan,
        planLabel: PLAN_LABELS[e.payload.plan] || e.payload.plan,
        state: expired ? 'expired' : current ? 'active' : 'paused',
        current,
        daysLeft: daysOf(remaining(e)),
        endsOn: current && !expired ? new Date(effExp(e)).toISOString() : null,
        canUse: !current && !expired,
      };
    });
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
      tier: 'free',
      tierLabel: tiers.TIER_LABELS.free,
      licensedTier: null,
      licenses: [],
      notice,
    };
    if (Math.abs(sys - T) > DIFF_WARN) {
      base.clockWarning = `The PC date (${new Date(sys).toLocaleDateString()}) differs from the POS calendar (${new Date(T).toLocaleDateString()}). The POS keeps counting from its own calendar. Please check the PC date and the clock battery.`;
    }

    if (o.devBypass) {
      return { ...base, tier: 'premium', tierLabel: tiers.TIER_LABELS.premium, licensedTier: 'premium', state: 'active', locked: false, plan: 'DEV', planLabel: 'Development (no license check)', message: 'License check is bypassed (development only).', _expMs: Infinity };
    }
    if (publicKeys.length === 0) {
      return { ...base, state: 'invalid', locked: true, message: 'Licensing is not configured in this build (no public key). See docs/LICENSING_GUIDE.md.', _expMs: 0 };
    }
    if (invalid) {
      return { ...base, state: 'invalid', locked: true, message: invalid.message, _expMs: 0 };
    }
    const entry = activeSlot && slots[activeSlot];
    if (!entry) {
      return { ...base, state: 'unlicensed', locked: true, message: 'Enter your license key to unlock the POS. Only Settings works until then.', _expMs: 0 };
    }

    const expMs = effExp(entry);
    const licensedTier = activeSlot;
    const detail = {
      licensedTier,
      licenses: licenseList(),
      plan: entry.payload.plan,
      planLabel: PLAN_LABELS[entry.payload.plan] || entry.payload.plan,
      customer: entry.payload.cust || null,
      issuedAt: Number.isFinite(entry.payload.iat) ? new Date(entry.payload.iat * 1000).toISOString() : null,
      expiresAt: new Date(expMs).toISOString(),
    };
    if (isExpired(entry)) {
      return {
        ...base,
        ...detail,
        state: 'expired',
        locked: true,
        daysLeft: 0,
        message: 'This license has expired. Enter a new key. Your data is safe: Settings and Backup still work.',
        _expMs: expMs,
      };
    }
    const daysLeft = daysOf(remaining(entry));
    return {
      ...base,
      ...detail,
      tier: licensedTier,
      tierLabel: label(licensedTier),
      state: 'active',
      locked: false,
      daysLeft,
      expiringSoon: daysLeft <= WARN_BEFORE_DAYS,
      message: daysLeft <= WARN_BEFORE_DAYS ? `License expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Please renew.` : 'License is active.',
      _expMs: expMs,
    };
  }

  /**
   * The Hardware ID normally comes from Windows (MachineGuid). If that read failed at
   * start-up we run on a weaker fallback id, and a valid licence would look like it belongs
   * to another PC. Never leave the customer locked for the whole session because of one
   * failed read: look again every few minutes, and re-check the saved licence once Windows answers.
   */
  async function retryHardwareId() {
    if (hw.source !== 'file' || !o.getHardwareId || o.devBypass) return;
    const t = now();
    if (t - lastHwRetry < HW_RETRY_MS) return;
    lastHwRetry = t;
    try {
      const again = await o.getHardwareId();
      if (again && again.id && again.source !== 'file') {
        hw = again;
        if (savedText && !hasAny()) {
          loadWallet(savedText);
          applyWalletMeta();
          normalizeWallet();
        }
        log('[license] hardware id recovered from the OS');
      }
    } catch (err) {
      log('[license] hardware id retry failed', err);
    }
  }

  async function refresh() {
    await retryHardwareId();
    advance();
    await applyEvidence();
    calibrateFromLicense();
    fallbackIfEnded();
    if (dirty || T - persistedT >= PERSIST_STEP_MS) await persistClock();
    cached = buildStatus();
    return publicStatus(cached);
  }

  const publicStatus = (s) => {
    const { _expMs, ...rest } = s;
    // The screen gets the full page/feature table so it never has to guess which tier opens what.
    return { ...rest, pages: tiers.pageAccess(rest.tier), features: tiers.featureAccess(rest.tier) };
  };

  // ---------- public API ----------
  async function init() {
    hw = await o.getHardwareId();
    await loadClockState();
    const text = o.licenseFiles ? await o.licenseFiles.load() : null;
    savedText = text || null;
    if (text) loadWallet(text);
    applyWalletMeta();
    calibrateFromLicense();
    normalizeWallet();
    fallbackIfEnded();
    const status = await refresh();
    await persistClock(); // write the calendar and the wallet to every store on first run
    return status;
  }

  async function activateNow(text) {
    const t = cleanKeyText(text);
    if (!t) throw new Error('Paste the license key first.');
    if (t.startsWith(REPAIR_PREFIX)) return applyRepair(t);
    if (!t.startsWith(LICENSE_PREFIX)) throw new Error('That does not look like a license key. It should start with POS1.');

    lastHwRetry = 0;
    await retryHardwareId();
    const r = checkLicenseText(t);
    if (!r.ok) throw new Error(r.message);
    advance();
    if (T >= r.payload.exp * 1000) throw new Error('This key has already expired. Ask for a new key.');

    const name = tierOf(r.payload);
    const cur = slots[name];
    if ((r.payload.iat || 0) < (floors[name] || 0)) {
      throw new Error('This key is older than your current plan. Enter the newest key.');
    }
    // A key issued LATER replaces the license of the same tier at once - no gap, no lock.
    // An OLDER key can never replace a newer one (so a stale key can't be re-entered).
    if (cur && (r.payload.iat || 0) < (cur.payload.iat || 0)) {
      throw new Error('This key is older than the one already on this PC. Enter the newest key.');
    }

    const backup = { slots: { ...slots }, activeSlot, savedText, wv, floors: { ...floors } };
    const entry = { text: t, id: keyId(t), payload: r.payload, off: 0, pausedAt: null };
    // Same tier renewed: the paused time already collected carries over (the new key counts from the old end).
    if (cur && r.payload.exp >= cur.payload.exp) {
      entry.off = clampOffset(entry, cur.off);
      entry.pausedAt = cur.pausedAt;
    }
    slots[name] = entry;

    // An exclusive key (refund / downgrade / replace-all) removes the other licenses it is newer than.
    if (r.payload.excl) {
      for (const other of SLOTS) {
        if (other === name) continue;
        floors[other] = Math.max(floors[other] || 0, r.payload.iat || 0);
        if (slots[other] && (slots[other].payload.iat || 0) <= (r.payload.iat || 0)) slots[other] = null;
      }
    }

    const running = activeSlot && slots[activeSlot] && !isExpired(slots[activeSlot]) ? activeSlot : null;
    if (!running || r.payload.excl) {
      activeSlot = name; // nothing usable was running: start the new one
      if (entry.pausedAt != null) resumeEntry(entry);
    } else if (name === running) {
      // renewal of the running license: stays active
    } else if (tiers.RANK[name] > tiers.RANK[running]) {
      switchTo(name); // upgrade: the new tier starts now, the lower one is paused (its days are kept)
      notice = `${label(name)} started. Your ${label(running)} days are paused and kept.`;
    } else {
      if (entry.pausedAt == null) entry.pausedAt = T; // a lower tier is saved for later; its days wait
      notice = `${label(name)} license saved. It starts when you choose it or when ${label(running)} ends.`;
    }
    wv += 1;
    invalid = null;
    sync();

    try {
      savedText = serializeWallet();
      await saveWallet();
    } catch (err) {
      Object.assign(slots, { premium: null, pro: null }, backup.slots);
      activeSlot = backup.activeSlot;
      savedText = backup.savedText;
      wv = backup.wv;
      floors = backup.floors;
      sync();
      throw err;
    }
    calibrateFromLicense();
    await persistClock();
    return refresh();
  }

  // One activation at a time: two overlapping calls (double click, two windows) must not
  // let an older key finish last and overwrite a newer one.
  let activateChain = Promise.resolve();
  function activate(text) {
    const run = activateChain.then(() => activateNow(text));
    activateChain = run.catch(() => {});
    return run;
  }

  /** The customer picks which license runs. The running one is paused (its days are kept). */
  async function useLicense(name) {
    advance();
    const target = slots[name];
    if (!target) throw new Error('That license is not on this PC.');
    if (name === activeSlot && !isExpired(target)) return refresh();
    if (isExpired(target)) throw new Error('That license has ended.');
    const from = activeSlot;
    switchTo(name);
    notice = from && slots[from] && from !== name ? `${label(name)} started. ${label(from)} is paused and its days are kept.` : `${label(name)} started.`;
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
      throw new Error('Set the PC date and time correctly, then enter the repair code again.');
    }
    if (tokenNow <= lastRepair) throw new Error('This repair code was already used.');
    lastRepair = tokenNow;
    // A licence whose issue date is later than the vendor's confirmed real date was signed on a PC
    // with a wrong clock. Its issue date would keep dragging the calendar forward, so remove it
    // and ask for the corrected key. (Re-entering it is harmless: the calendar is only ever
    // floored at a key's issue date, exactly as before.)
    let dropped = false;
    for (const n of SLOTS) {
      const e = slots[n];
      if (e && Number.isFinite(e.payload.iat) && e.payload.iat * 1000 > tokenNow + 2 * DAY) {
        slots[n] = null;
        dropped = true;
      }
    }
    T = tokenNow;
    sLast = now();
    monoLast = mono();
    if (dropped) {
      if (activeSlot && !slots[activeSlot]) activeSlot = null;
      savedText = serializeWallet() || null;
      await saveWallet();
      normalizeWallet();
      wv += 1;
    }
    calibrateFromLicense();
    await persistClock();
    return refresh();
  }

  /**
   * Cheap, synchronous - called for every IPC request. If the running license ended a moment ago
   * and another one is waiting, switch right here instead of waiting for the next minute tick.
   */
  function isLocked() {
    if (o.devBypass) return false;
    if (!cached) return true;
    if (cached.state === 'active' && trustedNow() >= cached._expMs) {
      advance();
      fallbackIfEnded();
      cached = buildStatus();
    }
    return cached.state !== 'active' || trustedNow() >= cached._expMs;
  }

  /**
   * The tier in force RIGHT NOW. Cheap and synchronous (called for every IPC request).
   * 'free' whenever the POS is locked, even if a licence is saved (expired/invalid).
   */
  function getTier() {
    if (o.devBypass) return 'premium';
    if (isLocked()) return 'free';
    return cached.tier;
  }
  function hasTier(need) {
    return tiers.tierSatisfies(getTier(), need);
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

  return { init, activate, useLicense, getStatus: refresh, isLocked, getTier, hasTier, start, stop, flush: persistClock };
}

/** Kept for compatibility: channels that work without a licence (the Free tier). See tiers.js. */
function isChannelAllowedWhenLocked(channel, CH) {
  return tiers.isFreeChannel(channel, CH);
}

module.exports = { createLicenseManager, isChannelAllowedWhenLocked, PLAN_LABELS, tiers };
