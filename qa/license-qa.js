#!/usr/bin/env node
'use strict';

/**
 * Licensing QA harness (black-box + white-box) for the Offline POS.
 *
 *   node qa/license-qa.js
 *
 * Runs the REAL license modules (verify, manager, clock guard, hardware id,
 * vendor tool) against a simulated PC: controllable clock, monotonic timer,
 * in-memory stores, a throw-away test keypair. Nothing here touches the
 * real private key or a real customer machine.
 *
 * Result kinds:
 *   PASS     behaved as a production system should
 *   FAIL     a defect (severity in brackets)
 *   LIMIT    known/documented limit of offline licensing, measured here
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const R = (p) => require(path.join(ROOT, p));
const { createLicenseManager, isChannelAllowedWhenLocked } = R('electron/license/licenseManager');
const fmt = R('electron/license/licenseFormat');
const tool = R('tools/license/licenseTool');
const { getHardwareId, parseMachineGuid, hashToHardwareId } = R('electron/license/hardwareId');
const tiers = R('electron/license/tiers');

const DAY = 86400000;
const HOUR = 3600000;
const BASE = Date.UTC(2026, 10, 10, 12, 0, 0); // "today" for the simulation
const HW = 'AAAA-BBBB-CCCC-DDDD';

// ---------------------------------------------------------------- plumbing
const results = [];
const add = (kind, sev, id, title, note = '') => results.push({ kind, sev, id, title, note });
const pass = (id, title) => add('PASS', '', id, title);
const fail = (sev, id, title, note) => add('FAIL', sev, id, title, note);
const limit = (id, title, note) => add('LIMIT', '', id, title, note);
const check = (id, title, cond, sev, note) => (cond ? pass(id, title) : fail(sev, id, title, note));
const days = (ms) => Math.round((ms / DAY) * 10) / 10;

const kp = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519'); // an attacker's own key
const PUB = [{ kid: '1', pem: kp.publicKey.export({ type: 'spki', format: 'pem' }) }];

function issue(o = {}) {
  return tool.issueLicense({
    privateKey: o.privateKey || kp.privateKey,
    kid: o.kid || '1',
    hardwareId: o.hw || HW,
    customer: o.cust || 'QA Cafe',
    plan: o.plan || 'Y01',
    tier: o.tier || 'premium',
    exclusive: !!o.exclusive,
    from: o.from,
    expires: o.expires,
    epoch: o.epoch ?? 1,
    now: new Date(o.now ?? BASE),
  });
}

function repairCode(atMs, hw = HW) {
  return tool.issueRepair({ privateKey: kp.privateKey, hardwareId: hw, now: new Date(atMs) }).key;
}

const memStore = () => ({
  v: null,
  async read() {
    return this.v ? JSON.parse(this.v) : null;
  },
  async write(o) {
    this.v = JSON.stringify(o);
  },
});

/** One simulated PC. */
function world(o = {}) {
  const w = {
    sys: o.sys ?? BASE,
    mono: 5_000_000,
    orders: o.orders ?? null,
    backup: o.backup ?? null,
    licenseText: o.licenseText ?? null,
    stores: [memStore(), memStore(), memStore()],
    hw: o.hw || HW,
    hwSource: 'machine-guid',
    keys: o.keys || PUB,
    minEpoch: o.minEpoch || 1,
    devBypass: !!o.devBypass,
    m: null,
  };
  w.run = (ms) => {
    w.sys += ms;
    w.mono += ms;
  };
  w.sleep = (ms) => {
    w.sys += ms; // PC clock moves, monotonic timer does not (suspend)
  };
  w.step = async (ms, stepMs = HOUR) => {
    for (let t = 0; t < ms; t += stepMs) {
      w.run(Math.min(stepMs, ms - t));
      await w.m.getStatus();
    }
  };
  w.boot = async () => {
    w.mono += 1_000_000; // a restart: the monotonic timer is unrelated to the previous run
    w.m = createLicenseManager({
      now: () => w.sys,
      mono: () => w.mono,
      getHardwareId: async () => ({ id: w.hw, source: w.hwSource }),
      publicKeys: w.keys,
      minEpoch: w.minEpoch,
      licenseFiles: {
        load: async () => w.licenseText,
        save: async (t) => {
          w.licenseText = t;
        },
      },
      clockStores: w.stores,
      getLatestOrderMs: async () => w.orders,
      getBackupMs: async () => w.backup,
      devBypass: w.devBypass,
      log: () => {},
    });
    await w.m.init();
    return w.m;
  };
  w.shutdown = async () => w.m.flush();
  w.wipeClockCopies = () => w.stores.forEach((s) => (s.v = null));
  return w;
}

const tryActivate = async (m, text) => {
  try {
    return { ok: true, status: await m.activate(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

// ---------------------------------------------------------------- A. crypto / key format
async function groupCrypto() {
  const good = issue().key;
  const pl = (k) => JSON.parse(Buffer.from(k.slice(5).split('.')[0], 'base64url').toString());

  {
    const w = world();
    await w.boot();
    const r = await tryActivate(w.m, good);
    check('A01', 'valid key activates and unlocks', r.ok && r.status.state === 'active' && !w.m.isLocked(), 'critical', JSON.stringify(r));
  }

  // tampering
  const [pB, sB] = good.slice(5).split('.');
  const p = JSON.parse(Buffer.from(pB, 'base64url').toString());
  const forge = (mut) => {
    const q = { ...p, ...mut };
    return `POS1.${Buffer.from(JSON.stringify(q)).toString('base64url')}.${sB}`;
  };
  for (const [name, mut] of [
    ['extend exp by 10 years', { exp: p.exp + 3650 * 86400 }],
    ['change machine id', { mid: 'FFFF-FFFF-FFFF-FFFF' }],
    ['change plan only', { plan: 'Y10' }],
    ['raise epoch', { epoch: 99 }],
    ['change customer name', { cust: 'Someone Else' }],
  ]) {
    const r = fmt.verifySigned(forge(mut), 'license', PUB);
    check('A02', `payload edit rejected: ${name}`, !r.ok && r.reason === 'bad-signature', 'critical', JSON.stringify(r));
  }

  // signature damage
  {
    const sig = Buffer.from(sB, 'base64url');
    sig[10] ^= 1;
    const r = fmt.verifySigned(`POS1.${pB}.${sig.toString('base64url')}`, 'license', PUB);
    check('A03', 'single flipped signature bit rejected', !r.ok, 'critical');
  }

  // Ed25519 malleability: S + L
  {
    const sig = Buffer.from(sB, 'base64url');
    const L = (1n << 252n) + 27742317777372353535851937790883648493n;
    let s = 0n;
    for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(sig[32 + i]);
    s += L;
    const out = Buffer.from(sig);
    for (let i = 0; i < 32; i++) out[32 + i] = Number((s >> BigInt(8 * i)) & 0xffn);
    const r = fmt.verifySigned(`POS1.${pB}.${out.toString('base64url')}`, 'license', PUB);
    check('A04', 'non-canonical (malleable) Ed25519 signature rejected', !r.ok, 'low', 'a second valid-looking key text for the same license exists');
  }

  // attacker signs with their own key but claims kid 1
  {
    const evil = issue({ privateKey: other.privateKey }).key;
    const w = world();
    await w.boot();
    const r = await tryActivate(w.m, evil);
    check('A05', 'license signed by attacker key (same kid) rejected', !r.ok && w.m.isLocked(), 'critical', JSON.stringify(r));
  }
  {
    const evil = issue({ privateKey: other.privateKey, kid: '77' }).key;
    const r = fmt.verifySigned(evil, 'license', PUB);
    check('A06', 'unknown key id rejected', !r.ok && r.reason === 'unknown-key', 'critical');
  }

  // structural garbage
  for (const [name, text] of [
    ['empty', ''],
    ['whitespace only', '   \n\t '],
    ['prefix only', 'POS1.'],
    ['one part', 'POS1.abc'],
    ['three parts', `${good}.AAAA`],
    ['wrong prefix', good.replace('POS1.', 'POS2.')],
    ['lowercase prefix', good.replace('POS1.', 'pos1.')],
    ['json not object', `POS1.${Buffer.from('123').toString('base64url')}.${sB}`],
    ['null payload', `POS1.${Buffer.from('null').toString('base64url')}.${sB}`],
    ['truncated', good.slice(0, good.length - 12)],
    ['non-string input', undefined],
  ]) {
    let ok = true;
    try {
      const r = fmt.verifySigned(text, 'license', PUB);
      ok = r.ok === false;
    } catch {
      ok = false; // must never throw
    }
    check('A07', `garbage input handled without crash: ${name}`, ok, 'high');
  }

  // domain separation
  {
    const rc = repairCode(BASE);
    const asLicense = fmt.verifySigned(rc.replace('POS1R.', 'POS1.'), 'license', PUB);
    const licAsRepair = fmt.verifySigned(good.replace('POS1.', 'POS1R.'), 'repair', PUB);
    check('A08', 'repair code cannot be replayed as a license, nor a license as a repair code', !asLicense.ok && !licAsRepair.ok, 'critical');
  }

  // wrong machine / normalisation
  {
    const w = world({ hw: '1111-2222-3333-4444' });
    await w.boot();
    const r = await tryActivate(w.m, good);
    check('A09', 'license for another PC rejected (clear message)', !r.ok && /different PC/.test(r.error) && w.m.isLocked(), 'critical', r.error);
    const w2 = world({ hw: 'aaaa bbbb cccc dddd' });
    await w2.boot();
    const r2 = await tryActivate(w2.m, good);
    check('A10', 'hardware id compare ignores case, dashes and spaces', r2.ok, 'medium', r2.error);
  }

  // epoch
  {
    const w = world({ minEpoch: 2 });
    await w.boot();
    const r = await tryActivate(w.m, issue({ epoch: 1 }).key);
    const r2 = await tryActivate(w.m, issue({ epoch: 2 }).key);
    check('A11', 'epoch bump: old-epoch key rejected, new-epoch key accepted', !r.ok && r2.ok, 'high', JSON.stringify([r.error, r2.error]));
  }

  // signed-but-malformed payloads (vendor bug / future format)
  for (const [name, payload] of [
    ['v=2', { ...p, v: 2 }],
    ['exp is a string', { ...p, exp: String(p.exp) }],
    ['exp missing', (({ exp, ...x }) => x)(p)],
    ['mid missing', (({ mid, ...x }) => x)(p)],
  ]) {
    const key = fmt.signPayload(fmt.LICENSE_PREFIX, fmt.LICENSE_DOMAIN, payload, kp.privateKey);
    const w = world();
    await w.boot();
    const r = await tryActivate(w.m, key);
    check('A12', `correctly signed but malformed payload rejected: ${name}`, !r.ok && w.m.isLocked(), 'high', JSON.stringify(r));
  }

  // wrapped/pasted keys
  {
    const wrapped = good.replace(/(.{40})/g, '$1\n  ');
    const w = world();
    await w.boot();
    const r = await tryActivate(w.m, `\n  ${wrapped}  \r\n`);
    check('A13', 'key wrapped by WhatsApp line breaks / spaces activates', r.ok, 'high', r.error);
  }
  for (const [name, ch] of [
    ['LRM U+200E', '\u200E'],
    ['RLM U+200F', '\u200F'],
    ['bidi embedding U+202A', '\u202A'],
    ['bidi pop U+202C', '\u202C'],
    ['word joiner U+2060', '\u2060'],
    ['soft hyphen U+00AD', '\u00AD'],
    ['NBSP U+00A0', '\u00A0'],
  ]) {
    const mid = Math.floor(good.length / 2);
    const dirty = `${ch}${good.slice(0, mid)}${ch}${good.slice(mid)}${ch}`;
    const w = world();
    await w.boot();
    const r = await tryActivate(w.m, dirty);
    check('A14', `key pasted with invisible character still activates: ${name}`, r.ok, 'medium', `rejected: ${r.error}`);
  }

  // mutation fuzz: nothing but byte-identical content may verify
  {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.=+/ ';
    const body = good.slice(5);
    const origBytes = Buffer.concat([Buffer.from(body.split('.')[0], 'base64url'), Buffer.from(body.split('.')[1], 'base64url')]);
    let accepted = 0;
    let acceptedDifferent = 0;
    for (let i = 0; i < 4000; i++) {
      let t = body;
      const pos = Math.floor(rnd() * t.length);
      const mode = Math.floor(rnd() * 3);
      const c = alphabet[Math.floor(rnd() * alphabet.length)];
      t = mode === 0 ? t.slice(0, pos) + c + t.slice(pos + 1) : mode === 1 ? t.slice(0, pos) + t.slice(pos + 1) : t.slice(0, pos) + c + t.slice(pos);
      const r = fmt.verifySigned(`POS1.${t}`, 'license', PUB);
      if (r.ok) {
        accepted++;
        const pp = t.split('.');
        const b = Buffer.concat([Buffer.from(pp[0], 'base64url'), Buffer.from(pp[1], 'base64url')]);
        if (!b.equals(origBytes)) acceptedDifferent++;
      }
    }
    check('A15', `4000 random single-edit mutations: none verifies with different content (benign re-encodings accepted: ${accepted})`, acceptedDifferent === 0, 'critical');
  }
}

// ---------------------------------------------------------------- B. expiry & plans
async function groupExpiry() {
  // expiry boundary, using real elapsed time (never by jumping the PC clock)
  const toExpiry = async (w) => {
    const st = await w.m.getStatus();
    return Date.parse(st.expiresAt) - Date.parse(st.trustedNow);
  };
  const w = world();
  await w.boot();
  await w.m.activate(issue({ plan: 'M30' }).key);
  w.run((await toExpiry(w)) - 1000);
  const before = (await w.m.getStatus()).state;
  w.run(2000);
  const atExp = (await w.m.getStatus()).state;
  check('B01', 'active one second before expiry, expired just after it', before === 'active' && atExp === 'expired', 'high', `${before}/${atExp}`);

  const w2 = world();
  await w2.boot();
  await w2.m.activate(issue({ plan: 'M30' }).key);
  w2.run((await toExpiry(w2)) - 30 * 1000);
  await w2.m.getStatus();
  const lockedBefore = w2.m.isLocked();
  w2.run(60 * 1000); // no refresh tick in between
  check('B02', 'isLocked() flips at expiry even before the next refresh tick', lockedBefore === false && w2.m.isLocked() === true, 'high');

  const w3 = world();
  await w3.boot();
  await w3.m.activate(issue({ plan: 'Y01' }).key);
  w3.run((await toExpiry(w3)) - 6.5 * DAY);
  const s = await w3.m.getStatus();
  check('B03', 'expiring-soon warning appears inside the last 7 days', s.expiringSoon === true && s.daysLeft <= 7 && s.daysLeft >= 1, 'medium', JSON.stringify({ d: s.daysLeft, e: s.expiringSoon }));

  // plan arithmetic
  const sec = (plan, from, expires) => new Date(tool.computeExpirySeconds({ plan, from: new Date(from), expires }) * 1000).toISOString();
  check('B04', 'Y01 from 29 Feb 2028 -> 28 Feb 2029 end of day UTC', sec('Y01', '2028-02-29T10:00:00Z') === '2029-02-28T23:59:59.000Z', 'medium', sec('Y01', '2028-02-29T10:00:00Z'));
  check('B05', 'M30 from 31 Jan 2027 -> 2 Mar 2027', sec('M30', '2027-01-31T10:00:00Z') === '2027-03-02T23:59:59.000Z', 'medium', sec('M30', '2027-01-31T10:00:00Z'));
  check('B06', 'Y10 from 1 Jan 2027 -> 1 Jan 2037', sec('Y10', '2027-01-01T00:00:00Z') === '2037-01-01T23:59:59.000Z', 'medium', sec('Y10', '2027-01-01T00:00:00Z'));
  for (const [name, fn] of [
    ['CUSTOM date in the past', () => tool.computeExpirySeconds({ plan: 'CUSTOM', from: new Date(BASE), expires: '2020-01-01' })],
    ['CUSTOM 2027-02-30 (not a real date)', () => tool.computeExpirySeconds({ plan: 'CUSTOM', from: new Date(BASE), expires: '2027-02-30' })],
    ['CUSTOM without a date', () => tool.computeExpirySeconds({ plan: 'CUSTOM', from: new Date(BASE) })],
    ['unknown plan', () => tool.computeExpirySeconds({ plan: 'LIFETIME', from: new Date(BASE) })],
    ['hardware id too short', () => issue({ hw: 'AAAA-BBBB' })],
    ['empty customer', () => issue({ cust: '   ' })],
  ]) {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    check('B07', `vendor tool refuses: ${name}`, threw, 'medium');
  }
  check('B08', 'CUSTOM expiring today is allowed (ends 23:59:59 UTC today)', (() => {
    try {
      tool.computeExpirySeconds({ plan: 'CUSTOM', from: new Date(BASE), expires: '2026-11-10' });
      return true;
    } catch {
      return false;
    }
  })(), 'low');

  // already-expired key refused at activation, and nothing is saved
  const w4 = world();
  await w4.boot();
  const stale = issue({ now: BASE - 400 * DAY });
  const r = await tryActivate(w4.m, stale.key);
  check('B09', 'expired key refused at activation and not written to disk', !r.ok && w4.licenseText === null, 'high', JSON.stringify(r));

  // renewal bookkeeping
  const csvRow = (issuedAt, type, cust, hw, plan, exp) => [issuedAt, type, cust, hw, plan, exp, '1', 'KEY'].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
  const csv = `issued_at,type,customer,hardware_id,plan,expires,kid,key\n${csvRow('2026-01-01T00:00:00Z', 'license', 'A1 "Bite", Lahore', HW, 'Y01', '2027-01-01')}\n${csvRow('2026-06-01T00:00:00Z', 'repair', '', HW, '', '')}\n`;
  check('B10', 'renewal finds current expiry (quotes/commas in customer name, repair rows ignored)', tool.readLastExpiry(csv, HW) === '2027-01-01', 'medium', String(tool.readLastExpiry(csv, HW)));
  const csvNl = `issued_at,type,customer,hardware_id,plan,expires,kid,key\n${csvRow('2026-01-01T00:00:00Z', 'license', 'Line1\nLine2', HW, 'Y01', '2027-01-01')}\n`;
  limit('B11', 'renewal row with a raw newline in the name still cannot be parsed', 'prevented at the source now: the issue tool flattens names (see F05)');
}

// ---------------------------------------------------------------- C. clock guard
async function groupClock() {
  const key = () => issue({ plan: 'Y01' }).key;

  // C1 normal use
  {
    const w = world();
    await w.boot();
    await w.m.activate(key());
    await w.step(10 * DAY, 6 * HOUR);
    const s = await w.m.getStatus();
    check('C01', '10 days of normal running: ~355 days left', s.daysLeft >= 354 && s.daysLeft <= 356, 'high', `daysLeft=${s.daysLeft}`);
  }

  // C2 clock put back while running
  {
    const w = world();
    await w.boot();
    await w.m.activate(key());
    await w.step(5 * DAY, 6 * HOUR);
    const before = (await w.m.getStatus()).daysLeft;
    w.sys -= 100 * DAY;
    await w.m.getStatus();
    await w.step(5 * DAY, 6 * HOUR);
    const s = await w.m.getStatus();
    check('C02', 'PC clock put back 100 days while running gains nothing', s.daysLeft <= before - 4 && !s.locked, 'critical', `before=${before} after=${s.daysLeft}`);
  }

  // C3 clock typed years ahead while running
  {
    const w = world();
    await w.boot();
    await w.m.activate(key());
    await w.step(DAY, 6 * HOUR);
    const before = (await w.m.getStatus()).daysLeft;
    w.sys += 9 * 365 * DAY;
    await w.m.getStatus();
    const s = await w.m.getStatus();
    const lost = before - s.daysLeft;
    check('C03', 'PC clock jumped +9 years while running costs at most about a week and never locks', !s.locked && lost <= 8, 'high', `lost ${lost} days, state ${s.state}`);
    w.sys -= 9 * 365 * DAY; // customer fixes the date
    await w.step(DAY, 6 * HOUR);
    const s2 = await w.m.getStatus();
    check('C04', 'fixing the PC date afterwards causes no lock and no extra loss', !s2.locked && s2.daysLeft >= s.daysLeft - 2, 'high', `${s.daysLeft} -> ${s2.daysLeft}`);
  }

  // C5 POS off for 30 days (honest customer on holiday)
  {
    const w = world();
    await w.boot();
    await w.m.activate(key());
    await w.step(DAY, 6 * HOUR);
    const before = (await w.m.getStatus()).daysLeft;
    await w.shutdown();
    w.sys += 30 * DAY; // off for 30 real days
    await w.boot();
    const s = await w.m.getStatus();
    limit('C05', `POS switched off 30 real days: only ${before - s.daysLeft} counted (cap is 7 per gap) - customer keeps ~${30 - (before - s.daysLeft)} free days`, 'documented trade-off');
  }

  // C6 sleep / suspend (monotonic timer stops, PC clock moves)
  {
    const w = world();
    await w.boot();
    await w.m.activate(key());
    const before = (await w.m.getStatus()).daysLeft;
    w.sleep(3 * DAY);
    const s = await w.m.getStatus();
    check('C06', 'laptop suspended 3 days: counted, no lock, no crash', !s.locked && before - s.daysLeft >= 2 && before - s.daysLeft <= 4, 'medium', `${before} -> ${s.daysLeft}`);
  }

  // C7 nightly restart + clock rollback (documented loophole) - quantify
  {
    const w = world();
    await w.boot();
    await w.m.activate(issue({ plan: 'M30' }).key);
    let realDays = 0;
    let st = await w.m.getStatus();
    while (!st.locked && realDays < 200) {
      await w.step(12 * HOUR, HOUR); // open 12 h
      await w.shutdown();
      w.sys += 12 * HOUR; // 12 h overnight ...
      w.sys -= 12 * HOUR; // ... but the cheater sets the PC clock back to closing time
      realDays += 1;
      await w.boot();
      st = await w.m.getStatus();
    }
    limit('C07', `nightly close + clock set back to closing time: 30-day trial lasted ${realDays} real days`, 'documented loophole; the PC date falls behind every day');
  }

  // C8 delete all copies + clock back, orders present vs absent
  for (const withOrders of [true, false]) {
    const w = world();
    await w.boot();
    await w.m.activate(key());
    await w.step(200 * DAY, 12 * HOUR);
    if (withOrders) w.orders = w.sys - HOUR;
    await w.shutdown();
    w.wipeClockCopies();
    w.sys -= 190 * DAY; // PC clock back 190 days
    await w.boot();
    const s = await w.m.getStatus();
    if (withOrders) limit('C08', `all calendar copies deleted + PC clock back 190 days, orders exist (but >10 days ahead of the PC clock so ignored): ${s.daysLeft} days left (honest value 165)`, 'documented; needs the PC date wrong for as long as it is used');
    else limit('C09', `all calendar copies deleted + PC clock back 190 days, no orders/backups: ${s.daysLeft} days left (honest value 165)`, 'documented; nothing to prove the date');
  }

  // C10 only the calendar copies edited back, honest clock, orders exist
  {
    const w = world();
    await w.boot();
    await w.m.activate(key());
    await w.step(200 * DAY, 12 * HOUR);
    w.orders = w.sys - HOUR;
    await w.shutdown();
    w.stores.forEach((s) => (s.v = JSON.stringify({ T: BASE, S: BASE, lastRepair: 0 })));
    await w.boot();
    const s = await w.m.getStatus();
    check('C10', 'calendar copies edited back to day 0 (honest PC clock, orders exist): revival blocked', s.daysLeft <= 166, 'high', `${s.daysLeft} days left`);
  }

  // C11 only the backup timestamp file is the evidence
  {
    const w = world();
    await w.boot();
    await w.m.activate(key());
    await w.step(200 * DAY, 12 * HOUR);
    w.backup = w.sys - 2 * HOUR;
    await w.shutdown();
    w.stores.forEach((s) => (s.v = JSON.stringify({ T: BASE, S: BASE, lastRepair: 0 })));
    await w.boot();
    const s = await w.m.getStatus();
    check('C11', 'backup time alone also works as the anti-rollback floor', s.daysLeft <= 166, 'medium', `${s.daysLeft}`);
  }

  // C12 garbage in the clock copies
  for (const [name, v] of [
    ['array', '[1,2,3]'],
    ['string', '"hello"'],
    ['T=null', '{"T":null,"S":null}'],
    ['T as numeric string', '{"T":"9999999999999"}'],
    ['T=Infinity-ish', '{"T":1e308}'],
    ['T before 2020', '{"T":1000}'],
    ['not json', '{{{{'],
  ]) {
    const w = world();
    await w.boot();
    await w.m.activate(key());
    await w.shutdown();
    w.stores.forEach((s) => (s.v = v));
    let ok = true;
    let s;
    try {
      await w.boot();
      s = await w.m.getStatus();
    } catch {
      ok = false;
    }
    // memStore.read JSON.parse throws on 'not json' -> the manager must survive a throwing store
    check('C12', `corrupt calendar copy survives start-up: ${name}`, ok && s && s.state === 'active', 'high', ok ? `state=${s && s.state}` : 'start-up crashed');
  }

  // C13 a store that throws on every read
  {
    const w = world();
    w.stores[0].read = async () => {
      throw new Error('disk error');
    };
    let ok = true;
    try {
      await w.boot();
      await w.m.activate(key());
    } catch {
      ok = false;
    }
    check('C13', 'unreadable calendar store does not stop start-up/activation', ok, 'high');
  }

  // C14 tampering one copy to 2099 (denial attempt) and the vendor repair path
  {
    const w = world();
    await w.boot();
    await w.m.activate(key());
    await w.shutdown();
    w.stores[1].v = JSON.stringify({ T: Date.UTC(2099, 0, 1), S: Date.UTC(2099, 0, 1), lastRepair: 0 });
    await w.boot();
    const locked = (await w.m.getStatus()).locked;
    const r = await tryActivate(w.m, repairCode(w.sys));
    const after = await w.m.getStatus();
    check('C14', 'one copy forged to year 2099 locks the POS, and a vendor repair code recovers it', locked && r.ok && !after.locked, 'medium', `locked=${locked} repair=${JSON.stringify(r.ok ? 'ok' : r.error)} after=${after.state}`);
  }

  // C15 repair-code replay with wiped memory + clock set back near the code's date
  for (const withOrders of [true, false]) {
    const w = world();
    await w.boot();
    await w.m.activate(key());
    await w.step(100 * DAY, 12 * HOUR);
    const rc = repairCode(w.sys); // legitimately issued on day 100
    const r1 = await tryActivate(w.m, rc);
    await w.step(200 * DAY, 12 * HOUR); // day 300
    if (withOrders) w.orders = w.sys - HOUR;
    const reuse = await tryActivate(w.m, rc);
    check('C15', 'repair code cannot be reused on the same PC (single use)', r1.ok && !reuse.ok, 'high', JSON.stringify(reuse));
    // attacker: wipe memory of use, PC clock back to day ~100, enter the old code, restore the clock
    await w.shutdown();
    w.wipeClockCopies();
    const real = w.sys;
    w.sys = Date.parse(JSON.parse(Buffer.from(rc.slice(6).split('.')[0], 'base64url')).now * 1000 ? new Date(JSON.parse(Buffer.from(rc.slice(6).split('.')[0], 'base64url').toString()).now * 1000).toISOString() : '');
    await w.boot();
    const r2 = await tryActivate(w.m, rc);
    w.sys = real; // clock restored
    await w.m.getStatus();
    w.run(5 * 60000);
    await w.m.getStatus();
    const s = await w.m.getStatus();
    const honest = 365 - 300;
    if (withOrders) check('C15b', `old repair code replayed with clock set back, orders exist: ${s.daysLeft} days left (honest ${honest})`, s.daysLeft <= honest + 8, 'high', `replay accepted=${r2.ok}`);
    else limit('C15c', `old repair code replayed with clock set back, NO orders/backups: ${s.daysLeft} days left (honest ${honest}) - replay accepted=${r2.ok}`, 'rewinds the calendar; same class as C09');
  }

  // C16 evidence: a future-dated order burns days permanently
  {
    const w = world();
    await w.boot();
    await w.m.activate(key());
    const before = (await w.m.getStatus()).daysLeft;
    w.orders = w.sys + 9 * DAY; // an order stamped while the PC date was a week ahead
    await w.m.getStatus();
    w.orders = null;
    const s = await w.m.getStatus();
    limit('C16', `one order stamped 9 days in the future (clock mistake) permanently burns ${before - s.daysLeft} days`, 'T never moves back; repair code is the only cure');
  }

  // C17 start before orders are readable
  {
    const w = world();
    const m = createLicenseManager({ now: () => w.sys, mono: () => w.mono, getHardwareId: async () => ({ id: HW, source: 'x' }), publicKeys: PUB, licenseFiles: null, clockStores: [] });
    check('C17', 'isLocked() is true before init() finishes', m.isLocked() === true, 'critical');
  }

  // C18 concurrent activations (old vs new key) - last writer wins?
  {
    const oldK = issue({ now: BASE, plan: 'M30' }).key;
    const newK = issue({ now: BASE + 5 * DAY, plan: 'Y01' }).key;
    const w = world({ sys: BASE + 6 * DAY });
    await w.boot();
    let slowSave = true;
    const origLoad = w.licenseText;
    // make the save of the OLD key slow so it completes after the new key's save
    const m2 = createLicenseManager({
      now: () => w.sys,
      mono: () => w.mono,
      getHardwareId: async () => ({ id: HW, source: 'x' }),
      publicKeys: PUB,
      licenseFiles: {
        load: async () => null,
        save: async (t) => {
          if (t === oldK.replace(/\s+/g, '') && slowSave) await new Promise((r) => setTimeout(r, 30));
          w.licenseText = t;
        },
      },
      clockStores: [memStore()],
    });
    await m2.init();
    await Promise.all([m2.activate(oldK), m2.activate(newK)]);
    check('C18', 'two activations racing: the newer key is the one left on disk', w.licenseText === newK, 'low', 'older key overwrote the newer one');
  }
}

// ---------------------------------------------------------------- D. hardware id
async function groupHardware() {
  const guidOut = (g) => `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${g}\r\n\r\n`;
  const a = await getHardwareId({ platform: 'win32', run: async () => guidOut('11111111-2222-3333-4444-555555555555'), userDataDir: '/tmp/qa-ud' });
  const b = await getHardwareId({ platform: 'win32', run: async () => guidOut('11111111-2222-3333-4444-555555555555'), userDataDir: '/tmp/qa-ud' });
  const c = await getHardwareId({ platform: 'win32', run: async () => guidOut('99999999-2222-3333-4444-555555555555'), userDataDir: '/tmp/qa-ud' });
  const up = await getHardwareId({ platform: 'win32', run: async () => guidOut('11111111-2222-3333-4444-555555555555'.toUpperCase()), userDataDir: '/tmp/qa-ud' });
  check('D01', 'same MachineGuid -> same id; different -> different; case-insensitive', a.id === b.id && a.id !== c.id && a.id === up.id && /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(a.id), 'high', JSON.stringify([a, c]));
  check('D02', 'MachineGuid parser tolerates CRLF and extra spacing', parseMachineGuid(guidOut('abc')) === 'abc', 'medium');

  // transient failure of reg.exe at start-up (antivirus delay, 5 s timeout, policy block)
  const ud = fs.mkdtempSync(path.join(require('os').tmpdir(), 'qa-hw-'));
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error('reg.exe timed out');
    return guidOut('11111111-2222-3333-4444-555555555555');
  };
  const first = await getHardwareId({ platform: 'win32', run: flaky, userDataDir: ud, retryDelayMs: 1 });
  const second = await getHardwareId({ platform: 'win32', run: flaky, userDataDir: ud, retryDelayMs: 1 });
  check('D03', 'a one-off reg.exe failure does NOT change the PC identity', first.id === second.id, 'high', `start-up id=${first.id} (${first.source}) vs normal id=${second.id} (${second.source})`);

  // even when every attempt fails, the manager must recover once Windows answers (no lock for the whole session)
  {
    const real = (await getHardwareId({ platform: 'win32', run: async () => guidOut('11111111-2222-3333-4444-555555555555'), userDataDir: ud })).id;
    const fallback = (await getHardwareId({ platform: 'win32', run: async () => { throw new Error('blocked'); }, userDataDir: ud, retryDelayMs: 1 }));
    const w = world();
    w.licenseText = issue({ hw: real }).key;
    let n = 0;
    w.m = createLicenseManager({
      now: () => w.sys,
      mono: () => w.mono,
      getHardwareId: async () => (n++ === 0 ? fallback : { id: real, source: 'machine-guid' }),
      publicKeys: PUB,
      licenseFiles: { load: async () => w.licenseText, save: async (t) => (w.licenseText = t) },
      clockStores: w.stores,
      log: () => {},
    });
    await w.m.init();
    w.run(5 * 60000);
    const s2 = await w.m.getStatus();
    check('D04', 'valid key is not locked for the whole session after a failed OS id read (self-heals within minutes)', fallback.source === 'file' && !s2.locked, 'high', `fallback source=${fallback.source}, state=${s2.state}`);
  }

  // fallback id changes when the data folder is wiped (non-Windows / reg failure): trial abuse path
  const u1 = fs.mkdtempSync(path.join(require('os').tmpdir(), 'qa-a-'));
  const u2 = fs.mkdtempSync(path.join(require('os').tmpdir(), 'qa-b-'));
  const f1 = await getHardwareId({ platform: 'darwin', userDataDir: u1 });
  const f2 = await getHardwareId({ platform: 'darwin', userDataDir: u2 });
  check('D05', `fallback id (source '${f1.source}') survives deleting the app data folder`, f1.id === f2.id, 'medium', 'a fresh data folder gives a fresh id: trial can be re-issued');
}

// ---------------------------------------------------------------- E. gate / static review
async function groupGate() {
  const CH = R('electron/ipc-channels');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const strKeys = Object.keys(CH).filter((k) => typeof CH[k] === 'string');
  const registered = new Set([...mainSrc.matchAll(/safeHandle\(\s*CH\.([A-Z0-9_]+)/g)].map((m) => m[1]));
  const unregistered = strKeys.filter((k) => !registered.has(k));
  const rawIpc = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'seed-images') walk(p);
      } else if (/\.js$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const hits = src.match(/ipcMain\.(handle|on|once|addListener)\s*\(/g) || [];
        if (hits.length && !p.endsWith('main.js')) rawIpc.push(path.relative(ROOT, p));
        if (p.endsWith('main.js')) {
          const outside = src.split('function safeHandle')[0].match(/ipcMain\.(handle|on|once)\s*\(/g) || [];
          if (outside.length) rawIpc.push('electron/main.js (before safeHandle)');
        }
      }
    }
  };
  walk(path.join(ROOT, 'electron'));
  check('E01', `no IPC handler bypasses the gate (${registered.size} via safeHandle; channels without a handler: ${unregistered.join(', ') || 'none'})`, rawIpc.length === 0, 'critical', rawIpc.join(', '));

  const allowed = strKeys.filter((k) => isChannelAllowedWhenLocked(CH[k], CH));
  const risky = allowed.filter((k) => /DELETE|CLEAR|RESTORE|MASTER|SET_LOCK|RUN_NOW|SETTINGS_SET/.test(k));
  limit('E02', `channels still callable while LOCKED that change or remove data: ${risky.join(', ')}`, 'by design (backup/settings must work); BACKUP_RESTORE and ORDER_DANGER_DELETE lower the anti-rollback evidence');

  // gate sanity by simulation on every channel
  const w = world();
  await w.boot();
  const lockedBlocked = strKeys.filter((k) => !isChannelAllowedWhenLocked(CH[k], CH)).length;
  check('E03', `while locked, ${lockedBlocked} of ${strKeys.length} channels are refused; license channels are reachable`, isChannelAllowedWhenLocked(CH.LICENSE_ACTIVATE, CH) && isChannelAllowedWhenLocked(CH.LICENSE_GET_STATUS, CH), 'critical');

  // prefix regex abuse: crafted channel names
  check('E04', 'allow-list regex cannot be satisfied by look-alike names (e.g. "xsecurity:a", "security")', !isChannelAllowedWhenLocked('xsecurity:a', CH) && !isChannelAllowedWhenLocked('security', CH) && !isChannelAllowedWhenLocked('order:create', CH), 'high');

  // dev bypass
  {
    const pkgJson = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    const readsEnvDirectly = /POS_LICENSE_DEV/.test(mainSrc.replace(/\/\/.*$/gm, ''));
    const excluded = /!electron\/license\/devBypass\.js/.test(pkgJson);
    const { isDevBypassEnabled } = R('electron/license/devBypass');
    const env = { POS_LICENSE_DEV: '1' };
    const renamedExe = isDevBypassEnabled({ app: { isPackaged: false, getAppPath: () => 'C:\\Users\\u\\AppData\\Local\\Programs\\Restaurant POS\\resources\\app.asar' }, env });
    const unpacked = isDevBypassEnabled({ app: { isPackaged: false, getAppPath: () => 'C:\\Pos\\resources\\app' }, env });
    const installed = isDevBypassEnabled({ app: { isPackaged: true, getAppPath: () => 'x' }, env });
    const dev = isDevBypassEnabled({ app: { isPackaged: false, getAppPath: () => '/home/dev/Offline-POS' }, env });
    check('E05', 'dev bypass cannot be switched on in an installed build (renamed exe, unpacked asar, packaged) and is not shipped', !readsEnvDirectly && excluded && !renamedExe && !unpacked && !installed && dev === true, 'high', JSON.stringify({ readsEnvDirectly, excluded, renamedExe, unpacked, installed, dev }));
  }
  const hook = fs.existsSync(path.join(ROOT, 'scripts/after-pack-fuses.js')) && /afterPack/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const hookSrc = hook ? fs.readFileSync(path.join(ROOT, 'scripts/after-pack-fuses.js'), 'utf8') : '';
  check('E06', 'installer hardens the exe with fuses (RunAsNode / NODE_OPTIONS / inspect off, app only from asar)', hook && /RunAsNode\]: false/.test(hookSrc) && /OnlyLoadAppFromAsar\]: true/.test(hookSrc), 'medium', 'afterPack fuses hook missing');
  limit('E06b', 'ASAR integrity validation is opt-in (POS_ASAR_INTEGRITY=1) until tested on a real Windows build', 'until then app.asar can still be edited by a determined user');
  const perMachine = /"perMachine"\s*:\s*true/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('E07', 'installer installs per-machine (program files not writable without admin)', perMachine, 'medium', 'nsis.perMachine is not set => per-user install under %LOCALAPPDATA%, which a normal user can edit without admin');

  // background work that survives the lock
  const wa = fs.readFileSync(path.join(ROOT, 'electron/whatsapp/whatsappService.js'), 'utf8');
  check('E08', 'a running WhatsApp campaign stops itself when the licence locks (behaviour tested in qa/whatsapp-license-qa.js)', /setLicenseGuard/.test(wa) && /setLicenseGuard\(/.test(mainSrc) && /function shouldStop/.test(wa), 'high');

  // secrets in the repo
  const ms = path.join(ROOT, 'electron/security/master-secret.generated.js');
  const tracked = fs.existsSync(ms) && require('child_process').execSync('git ls-files electron/security/master-secret.generated.js', { cwd: ROOT }).toString().trim() !== '';
  check('E09', 'no recovery master secret is committed to the repository', !tracked, 'critical', 'electron/security/master-secret.generated.js is tracked; the repository is public. Anyone can compute the PIN-recovery master key for any PC.');
}

// ---------------------------------------------------------------- F. vendor-side mistakes
async function groupVendor() {
  // 1) the tool must refuse to sign on a PC whose clock is wrong
  const skew = 3 * 365 * DAY;
  const c1 = tool.checkVendorClock({ nowMs: BASE + skew, onlineNowMs: BASE });
  const c2 = tool.checkVendorClock({ nowMs: BASE, onlineNowMs: BASE + 3000 });
  const c3 = tool.checkVendorClock({ nowMs: BASE - 2 * DAY, onlineNowMs: null, csvText: `issued_at\n"${new Date(BASE).toISOString()}","license"\n` });
  const c4 = tool.checkVendorClock({ nowMs: BASE, onlineNowMs: null });
  check('F01', 'issue tool refuses to sign when the PC date is 3 years off internet time, or older than the last key issued', !c1.ok && c2.ok && !c3.ok && c4.ok && c4.warnings.length === 1, 'medium', JSON.stringify({ c1, c3 }));
  check('F03', 'issue tool actually calls the date check before signing', /checkVendorClock\(/.test(fs.readFileSync(path.join(ROOT, 'tools/license/issue-license.js'), 'utf8')), 'medium');

  // 2) if a bad-date key still got out, the customer must be recoverable with a repair code
  const bad = issue({ now: BASE + skew, plan: 'M30' });
  const w = world();
  w.files = null;
  let disk = null;
  w.m = createLicenseManager({
    now: () => w.sys,
    mono: () => w.mono,
    getHardwareId: async () => ({ id: HW, source: 'machine-guid' }),
    publicKeys: PUB,
    licenseFiles: { load: async () => disk, save: async (t) => (disk = t), clear: async () => (disk = null) },
    clockStores: w.stores,
    log: () => {},
  });
  await w.m.init();
  const r1 = await tryActivate(w.m, bad.key);
  const good = issue({ now: BASE, plan: 'Y01' });
  const refused = await tryActivate(w.m, good.key);
  const rr = await tryActivate(w.m, repairCode(BASE));
  const afterRepair = await w.m.getStatus();
  const again = await tryActivate(w.m, good.key);
  // restart: the bad key must not come back from disk
  await w.m.flush();
  await w.m.init();
  const s = await w.m.getStatus();
  check('F02', 'bad-date key: repair code + corrected key recovers the customer, and the bad key does not return after a restart', r1.ok && !refused.ok && rr.ok && afterRepair.state === 'unlicensed' && again.ok && s.state === 'active' && s.daysLeft > 360, 'high', JSON.stringify({ bad: r1.ok, refused: refused.error, repair: rr.ok, afterRepair: afterRepair.state, again: again.error, afterRestart: s.state, daysLeft: s.daysLeft }));

  // 3) epoch default follows the app minimum
  const src = fs.readFileSync(path.join(ROOT, 'tools/license/issue-license.js'), 'utf8');
  check('F04', 'issue tool defaults --epoch to the app\'s MIN_LICENSE_EPOCH', /MIN_LICENSE_EPOCH/.test(src) && !/: 1,\s*\n\s*\}\)/.test(src.split('epoch: args.epoch')[1] || ''), 'medium');

  // 3b) the real command-line tool: tier is mandatory, closed input is an error (not a silent "success"), CSV gets a tier column
  {
    const { spawnSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'qa-cli-'));
    fs.writeFileSync(path.join(dir, 'private-1.pem'), kp.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' }));
    const script = path.join(ROOT, 'tools/license/issue-license.js');
    const env = { ...process.env, LICENSE_PASSPHRASE: 'pw' };
    const base = ['--dir', dir, '--machine', HW, '--customer', 'CLI Cafe', '--plan', 'M30', '--skip-date-check'];
    const noTier = spawnSync(process.execPath, [script, ...base], { env, input: '', encoding: 'utf8' });
    const badTier = spawnSync(process.execPath, [script, ...base, '--tier', 'free'], { env, input: '', encoding: 'utf8' });
    const good = spawnSync(process.execPath, [script, ...base, '--tier', 'pro'], { env, input: '', encoding: 'utf8' });
    const keyLine = (good.stdout || '').split('\n').find((l) => l.startsWith('POS1.'));
    const v = keyLine ? fmt.verifySigned(keyLine, 'license', [{ kid: '1', pem: kp.publicKey.export({ type: 'spki', format: 'pem' }) }]) : { ok: false };
    const csv = fs.existsSync(path.join(dir, 'issued-licenses.csv')) ? fs.readFileSync(path.join(dir, 'issued-licenses.csv'), 'utf8') : '';
    check('F06', 'CLI without --tier (stdin closed) fails with an error and issues nothing; --tier free is refused', noTier.status !== 0 && badTier.status !== 0 && !/POS1\./.test(noTier.stdout || '') && !/POS1\./.test(badTier.stdout || ''), 'high', `${noTier.status}/${badTier.status}`);
    check('F07', 'CLI with --tier pro issues a key that verifies, carries tier=pro, and records the tier in the CSV', good.status === 0 && v.ok && v.payload.tier === 'pro' && /,tier,exclusive\n/.test(csv) && /,"pro",""\n$/.test(csv), 'high', good.stderr);
  }

  // 4) customer names cannot break the CSV record
  const k = issue({ cust: 'Line1\nLine2\t"X"' });
  check('F05', 'customer name with line breaks is flattened (renewal record stays parseable)', !/[\n\r\t]/.test(k.payload.cust), 'low', JSON.stringify(k.payload.cust));
}


// ---------------------------------------------------------------- G. tiers (Free / Pro / Premium)
async function groupTiers() {
  const CH = R('electron/ipc-channels');
  const chanKeys = Object.keys(CH).filter((k) => typeof CH[k] === 'string');
  const callable = (tier) => chanKeys.filter((k) => tiers.tierSatisfies(tier, tiers.requiredTierForChannel(CH[k], CH)));
  const boot = async (text, opts = {}) => {
    const w = world(opts);
    w.licenseText = text;
    await w.boot();
    return w;
  };

  // the tier is inside the signature
  const pro = issue({ tier: 'pro' });
  const [pB, sB] = pro.key.slice(5).split('.');
  const p = JSON.parse(Buffer.from(pB, 'base64url').toString());
  const upgraded = `POS1.${Buffer.from(JSON.stringify({ ...p, tier: 'premium' })).toString('base64url')}.${sB}`;
  check('G01', 'editing "tier" from pro to premium inside a key breaks the signature', !fmt.verifySigned(upgraded, 'license', PUB).ok, 'critical');
  {
    const w = await boot(null);
    const r = await tryActivate(w.m, upgraded);
    check('G02', 'a hand-upgraded key is refused and the POS stays Free', !r.ok && w.m.getTier() === 'free', 'critical', JSON.stringify(r));
  }

  // Free
  {
    const w = await boot(null);
    const st = await w.m.getStatus();
    const free = callable('free');
    check('G03', 'no key = Free tier; only the Settings-page channels are callable', w.m.getTier() === 'free' && st.tier === 'free' && free.every((k) => /^(SETTINGS_|PRINTER_LIST|ORDER_DANGER|LICENSE_|SECURITY_|BACKUP_)/.test(k)) && free.length > 10, 'critical', free.join(','));
    check('G04', 'Free: every page except Settings is locked in the status table', Object.entries(st.pages).every(([id, a]) => (id === 'settings' ? a.allowed : !a.allowed)), 'high', JSON.stringify(st.pages));
  }

  // Pro
  {
    const w = await boot(pro.key);
    const st = await w.m.getStatus();
    const can = callable('pro');
    const cannot = chanKeys.filter((k) => !can.includes(k));
    check('G05', 'Pro: can call everything except the WhatsApp channels', w.m.getTier() === 'pro' && cannot.length > 0 && cannot.every((k) => /^WHATSAPP_/.test(k)) && chanKeys.filter((k) => /^WHATSAPP_/.test(k)).every((k) => cannot.includes(k)), 'critical', cannot.join(','));
    check('G06', 'Pro: status table opens every page but WhatsApp Deals', Object.entries(st.pages).every(([id, a]) => (id === 'whatsapp-deals' ? !a.allowed && a.required === 'premium' : a.allowed)) && !st.features.whatsapp.allowed && !st.features['whatsapp-timing'].allowed, 'high', JSON.stringify(st.pages));
    check('G07', 'Pro: hasTier(premium) is false and the status says "Pro"', !w.m.hasTier('premium') && w.m.hasTier('pro') && st.tierLabel === 'Pro', 'high');
  }

  // Premium
  {
    const w = await boot(issue({ tier: 'premium' }).key);
    const st = await w.m.getStatus();
    check('G08', 'Premium: every channel and every page is open', callable('premium').length === chanKeys.length && Object.values(st.pages).every((a) => a.allowed) && st.tierLabel === 'Premium', 'critical');
  }

  // legacy keys (issued before tiers) keep everything
  {
    const legacyPayload = { v: 1, kid: '1', mid: HW, plan: 'Y01', cust: 'Old Customer', iat: Math.floor(BASE / 1000), exp: Math.floor((BASE + 300 * DAY) / 1000), epoch: 1 };
    const legacyKey = fmt.signPayload(fmt.LICENSE_PREFIX, fmt.LICENSE_DOMAIN, legacyPayload, kp.privateKey);
    const w = await boot(legacyKey);
    check('G09', `key issued before tiers existed (no "tier") keeps working as ${tiers.LEGACY_TIER}`, w.m.getTier() === tiers.LEGACY_TIER && !w.m.isLocked(), 'high');
  }

  // invalid tier values inside a correctly signed key
  for (const bad of ['free', 'gold', 'PREMIUM', '', 5, null, ['premium']]) {
    const key = fmt.signPayload(fmt.LICENSE_PREFIX, fmt.LICENSE_DOMAIN, { ...p, tier: bad }, kp.privateKey);
    const w = await boot(null);
    const r = await tryActivate(w.m, key);
    check('G10', `signed key with tier=${JSON.stringify(bad)} is rejected`, !r.ok && w.m.getTier() === 'free', 'high', JSON.stringify(r));
  }

  // expiry drops to Free immediately
  {
    const w = await boot(issue({ tier: 'premium', plan: 'M30' }).key);
    const exp = Date.parse((await w.m.getStatus()).expiresAt);
    w.run(exp - w.sys - 30000);
    await w.m.getStatus();
    const before = w.m.getTier();
    w.run(60000); // no refresh tick
    check('G11', 'a Premium licence that expires falls to Free at once (before the next refresh tick)', before === 'premium' && w.m.getTier() === 'free' && !w.m.hasTier('pro'), 'critical', `${before} -> ${w.m.getTier()}`);
    const st = await w.m.getStatus();
    check('G12', 'expired status remembers what was licensed, but grants nothing', st.state === 'expired' && st.licensedTier === 'premium' && st.tier === 'free' && Object.entries(st.pages).every(([id, a]) => (id === 'settings' ? a.allowed : !a.allowed)), 'high', JSON.stringify({ s: st.state, l: st.licensedTier, t: st.tier }));
  }

  // wallet basics (full scenarios are in group H): upgrade starts Premium and keeps the Pro days; a plain lower-tier key is only saved
  {
    const w = await boot(null, { sys: BASE + 10 * DAY });
    const proKey = issue({ tier: 'pro', now: BASE + 1 * DAY });
    const premKey = issue({ tier: 'premium', now: BASE + 5 * DAY });
    const pro2 = issue({ tier: 'pro', now: BASE + 8 * DAY });
    const a1 = await tryActivate(w.m, proKey.key);
    const t1 = w.m.getTier();
    const a2 = await tryActivate(w.m, premKey.key);
    const t2 = w.m.getTier();
    const a3 = await tryActivate(w.m, pro2.key);
    const t3 = w.m.getTier();
    check('G13', 'pro -> premium upgrade starts Premium at once; a later plain Pro key does NOT downgrade (it is only saved)', a1.ok && a2.ok && a3.ok && t1 === 'pro' && t2 === 'premium' && t3 === 'premium', 'high', `${t1}/${t2}/${t3}`);
    // an EXCLUSIVE key is the vendor's way to downgrade / refund
    const downKey = issue({ tier: 'pro', now: BASE + 9 * DAY, exclusive: true });
    const a4 = await tryActivate(w.m, downKey.key);
    const t4 = w.m.getTier();
    const a5 = await tryActivate(w.m, premKey.key); // customer keeps the old Premium key and tries it again
    const t5 = w.m.getTier();
    check('G14', 'an exclusive Pro key removes Premium, and the old Premium key can no longer be re-entered', a4.ok && t4 === 'pro' && !a5.ok && t5 === 'pro', 'critical', JSON.stringify({ a4: a4.error, t4, a5: a5.error, t5 }));
  }

  // development bypass is premium
  {
    const w = await boot(null, { devBypass: true });
    check('G15', 'development bypass grants Premium (source checkout only)', w.m.getTier() === 'premium' && w.m.hasTier('premium'), 'low');
  }

  // catalog completeness
  const modulesSrc = fs.readFileSync(path.join(ROOT, 'src/shell/modules.js'), 'utf8');
  const uiPages = [...modulesSrc.matchAll(/\n    id: '([a-z-]+)'/g)].map((m) => m[1]).sort();
  const catalogPages = tiers.PAGES.map((x) => x.id).sort();
  check('G16', `every page in the app is classified (${uiPages.join(', ')}) - none missing, none extra`, JSON.stringify(uiPages) === JSON.stringify(catalogPages), 'critical', `app: ${uiPages} catalog: ${catalogPages}`);
  check('G17', 'catalog matches the rules: Settings=free, WhatsApp Deals=premium, all other pages=pro', tiers.PAGES.every((x) => x.tier === (x.id === 'settings' ? 'free' : x.id === 'whatsapp-deals' ? 'premium' : 'pro')), 'high');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const registered = [...mainSrc.matchAll(/safeHandle\(\s*CH\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  check('G18', `all ${registered.length} IPC handlers go through the tier gate and have a known requirement`, registered.every((k) => ['free', 'pro', 'premium'].includes(tiers.requiredTierForChannel(CH[k], CH))) && /requiredTierForChannel\(channel, CH\)/.test(mainSrc) && /!tierSatisfies\(have, need\)/.test(mainSrc), 'critical');
  check('G19', 'an unknown / new channel defaults to Pro (never free), "whatsapp:*" is Premium', tiers.requiredTierForChannel('brand-new:thing', CH) === 'pro' && tiers.requiredTierForChannel('whatsapp:anything', CH) === 'premium' && tiers.requiredTierForChannel('xsettings:set', CH) === 'pro', 'high');
  check('G20', 'refusal messages: Free -> "locked / enter key", Pro hitting WhatsApp -> "needs the Premium license"', /locked/.test(tiers.refusalMessage('free', 'pro')) && /needs the Premium license/.test(tiers.refusalMessage('pro', 'premium')) && /Your license is Pro/.test(tiers.refusalMessage('pro', 'premium')), 'medium');
  check('G21', 'WhatsApp background guard follows the tier (stops on expiry AND on a downgrade to Pro)', /setLicenseGuard\(\(\) => \(licenseManager \? !licenseManager\.hasTier\('premium'\)/.test(mainSrc), 'high');
  check('G22', 'sending-speed settings can only be saved with a Premium licence (enforced in main.js)', /touchesTimingKeys\(entries\)[\s\S]{0,200}hasTier\('premium'\)/.test(mainSrc), 'high');

  // vendor tool
  let threw = 0;
  for (const t of [undefined, '', 'free', 'gold', 'PREMIUM', null]) {
    try { tool.issueLicense({ privateKey: kp.privateKey, hardwareId: HW, customer: 'x', plan: 'M30', tier: t, now: new Date(BASE) }); } catch { threw++; }
  }
  check('G23', 'vendor tool will not sign a key without an explicit pro/premium tier', threw === 6, 'high', `${threw}/6 refused`);
  const csv = 'issued_at,type,customer,hardware_id,plan,expires,kid,key,tier\n' +
    `"2026-01-01T00:00:00Z","license","A","${HW}","Y01","2027-01-01","1","K1","pro"\n` +
    `"2026-06-01T00:00:00Z","license","A","${HW}","Y01","2027-06-01","1","K2","premium"\n` +
    `"2026-07-01T00:00:00Z","repair","","${HW}","","","1","R",""\n`;
  check('G24', 'renewal remembers the last tier issued to that PC (offered as the default)', tool.readLastTier(csv, HW) === 'premium' && tool.readLastExpiry(csv, HW) === '2027-06-01', 'low');
}


// ---------------------------------------------------------------- H. several licenses: pause, switch, fall back
async function groupWallet() {
  const mk = async (opts = {}) => {
    const w = world(opts);
    await w.boot();
    return w;
  };
  const lic = (st, slot) => (st.licenses || []).find((l) => l.slot === slot);
  const keyOf = (tier, plan, nowMs) => issue({ tier, plan, now: nowMs }).key;

  // H01-H03: upgrade pauses Pro, days are frozen, switching back works
  {
    const w = await mk();
    await w.m.activate(keyOf('pro', 'Y01', BASE));
    await w.step(10 * DAY, 6 * HOUR);
    const before = await w.m.getStatus();
    const proBefore = before.daysLeft;
    const up = await tryActivate(w.m, keyOf('premium', 'M30', w.sys));
    let st = await w.m.getStatus();
    check('H01', 'Premium entered while Pro is running: Premium starts now, Pro is paused with its days kept', up.ok && st.tier === 'premium' && lic(st, 'premium').state === 'active' && lic(st, 'pro').state === 'paused' && Math.abs(lic(st, 'pro').daysLeft - proBefore) <= 1, 'critical', JSON.stringify(st.licenses));
    await w.step(20 * DAY, 6 * HOUR);
    st = await w.m.getStatus();
    check('H02', 'Pro days stay frozen while Premium runs (20 days later: Pro unchanged, Premium used 20)', Math.abs(lic(st, 'pro').daysLeft - proBefore) <= 1 && lic(st, 'premium').daysLeft >= 9 && lic(st, 'premium').daysLeft <= 11, 'critical', JSON.stringify(st.licenses));
    const sw = await w.m.useLicense('pro');
    check('H03', 'customer switches to Pro: Pro runs, Premium is paused (days kept), WhatsApp is closed', sw.tier === 'pro' && !w.m.hasTier('premium') && lic(sw, 'premium').state === 'paused' && lic(sw, 'premium').daysLeft >= 9 && sw.notice && /paused/.test(sw.notice), 'high', JSON.stringify(sw.licenses));
    await w.step(5 * DAY, 6 * HOUR);
    st = await w.m.getStatus();
    check('H03b', 'while Pro runs again, Premium stays frozen and Pro counts down', lic(st, 'premium').daysLeft >= 9 && lic(st, 'premium').daysLeft <= 11 && lic(st, 'pro').daysLeft <= proBefore - 4, 'high', JSON.stringify(st.licenses));
  }

  // H04: Premium ends -> Pro starts by itself, no gap
  {
    const w = await mk();
    await w.m.activate(keyOf('pro', 'Y01', BASE));
    await w.m.activate(keyOf('premium', 'M30', BASE));
    const proDays = lic(await w.m.getStatus(), 'pro').daysLeft;
    const end = Date.parse((await w.m.getStatus()).expiresAt);
    w.run(end - w.sys - 30000);
    await w.m.getStatus();
    const lockedBefore = w.m.isLocked();
    w.run(60000); // Premium ends; NO refresh tick in between
    const lockedAfter = w.m.isLocked();
    const tierAfter = w.m.getTier();
    const st = await w.m.getStatus();
    check('H04', 'Premium ends: Pro starts by itself at once (never Free in between), with its full days and a notice', !lockedBefore && !lockedAfter && tierAfter === 'pro' && st.tier === 'pro' && Math.abs(st.daysLeft - proDays) <= 1 && /Premium has ended/.test(st.notice || ''), 'critical', JSON.stringify({ lockedBefore, lockedAfter, tierAfter, d: st.daysLeft, n: st.notice }));
  }

  // H05/H06: a lower-tier key while Premium runs is only saved; a renewal of a paused license stays paused
  {
    const w = await mk();
    await w.m.activate(keyOf('premium', 'M30', BASE));
    const r = await tryActivate(w.m, keyOf('pro', 'Y01', BASE));
    let st = await w.m.getStatus();
    check('H05', 'Pro key entered while Premium runs: saved and paused, Premium keeps running', r.ok && st.tier === 'premium' && lic(st, 'pro').state === 'paused' && /saved/.test(st.notice || ''), 'high', JSON.stringify(st.licenses));
    const before = lic(st, 'pro').daysLeft;
    const renew = issue({ tier: 'pro', plan: 'Y01', now: BASE + DAY, from: new Date(BASE + 365 * DAY) });
    const r2 = await tryActivate(w.m, renew.key);
    st = await w.m.getStatus();
    check('H06', 'renewal of the paused Pro license: more days, still paused, Premium still running', r2.ok && lic(st, 'pro').state === 'paused' && lic(st, 'pro').daysLeft > before + 300 && st.tier === 'premium', 'high', JSON.stringify(st.licenses));
  }

  // H07: both ended
  {
    const w = await mk();
    await w.m.activate(keyOf('pro', 'M30', BASE));
    await w.m.activate(keyOf('premium', 'M30', BASE));
    await w.step(80 * DAY, 12 * HOUR);
    const st = await w.m.getStatus();
    check('H07', 'both licenses ended: Free (locked), status says expired, nothing granted', st.locked && st.tier === 'free' && st.state === 'expired' && !w.m.hasTier('pro'), 'critical', JSON.stringify({ s: st.state, t: st.tier }));
  }

  // H08: survives a restart (pause bookkeeping is saved)
  {
    const w = await mk();
    await w.m.activate(keyOf('pro', 'Y01', BASE));
    await w.step(10 * DAY, 12 * HOUR);
    await w.m.activate(keyOf('premium', 'M30', w.sys));
    await w.step(7 * DAY, 12 * HOUR);
    const st1 = await w.m.getStatus();
    await w.shutdown();
    await w.boot();
    const st2 = await w.m.getStatus();
    check('H08', 'restart: same license running, same paused days (nothing lost, nothing gained)', st2.tier === st1.tier && lic(st2, 'pro').state === 'paused' && Math.abs(lic(st2, 'pro').daysLeft - lic(st1, 'pro').daysLeft) <= 1 && Math.abs(lic(st2, 'premium').daysLeft - lic(st1, 'premium').daysLeft) <= 1, 'critical', JSON.stringify([st1.licenses, st2.licenses]));
    // switched off for 3 weeks with Premium running: the paused Pro must not lose or gain
    await w.shutdown();
    w.sys += 3 * DAY;
    await w.boot();
    const st3 = await w.m.getStatus();
    check('H08b', 'POS off for 3 days: the paused Pro license is unchanged', Math.abs(lic(st3, 'pro').daysLeft - lic(st2, 'pro').daysLeft) <= 1, 'high', JSON.stringify(st3.licenses));
  }

  // H09: bookkeeping wiped -> no crash, no free days
  {
    const w = await mk();
    await w.m.activate(keyOf('pro', 'Y01', BASE));
    await w.step(10 * DAY, 12 * HOUR);
    await w.m.activate(keyOf('premium', 'Y01', w.sys));
    await w.step(40 * DAY, 12 * HOUR);
    const proKept = lic(await w.m.getStatus(), 'pro').daysLeft; // 355 days (frozen), honest
    await w.shutdown();
    w.wipeClockCopies();
    await w.boot();
    const st = await w.m.getStatus();
    check('H09', 'pause bookkeeping deleted: POS still starts, Premium (preferred) runs, and Pro gains NO days', st.tier === 'premium' && lic(st, 'pro').daysLeft <= proKept, 'high', JSON.stringify({ proKept, now: st.licenses }));
  }

  // H10: edited pause bookkeeping is clamped
  {
    const w = await mk();
    await w.m.activate(keyOf('pro', 'Y01', BASE));
    await w.step(5 * DAY, 12 * HOUR);
    await w.m.activate(keyOf('premium', 'Y01', w.sys));
    await w.step(5 * DAY, 12 * HOUR);
    const honest = lic(await w.m.getStatus(), 'pro').daysLeft;
    await w.shutdown();
    for (const stt of w.stores) {
      const rec = JSON.parse(stt.v);
      rec.w.s.pro.o = 20 * 365 * DAY; // pretend 20 years of pause in every copy
      stt.v = JSON.stringify(rec);
    }
    await w.boot();
    const st = await w.m.getStatus();
    const gain = lic(st, 'pro').daysLeft - honest;
    check('H10', `pause time edited to 20 years in every copy: gain is capped by the time since the key was issued (gained ${gain} days, never years)`, gain <= 12, 'high', `gain=${gain}`);
    // a single stale copy with a higher offset must not win over the newer ones
    const w2 = await mk();
    await w2.m.activate(keyOf('pro', 'Y01', BASE));
    await w2.m.activate(keyOf('premium', 'Y01', BASE));
    await w2.step(3 * DAY, 12 * HOUR);
    await w2.shutdown();
    const rec = JSON.parse(w2.stores[0].v);
    rec.w.wv = 0;
    rec.w.s.pro.o = 5 * DAY;
    w2.stores[0].v = JSON.stringify(rec);
    await w2.boot();
    const st2 = await w2.m.getStatus();
    check('H10b', 'one copy with an older wallet version cannot override the newer copies', lic(st2, 'pro').daysLeft <= lic(await w2.m.getStatus(), 'pro').daysLeft && lic(st2, 'pro').daysLeft <= 366, 'medium');
  }

  // H11: switch rules
  {
    const w = await mk();
    await w.m.activate(keyOf('pro', 'M30', BASE));
    const none = await tryActivate(w.m, '');
    let err = null;
    try { await w.m.useLicense('premium'); } catch (e) { err = e.message; }
    check('H11', 'switching to a license that is not on this PC is refused', /not on this PC/.test(err || ''), 'medium', err);
    await w.m.activate(keyOf('premium', 'M30', BASE));
    await w.step(40 * DAY, 12 * HOUR); // Premium ended, Pro auto-started and used 10 days
    const st = await w.m.getStatus();
    err = null;
    try { await w.m.useLicense('premium'); } catch (e) { err = e.message; }
    check('H11b', 'switching to an ended license is refused', /ended/.test(err || '') && st.tier === 'pro', 'medium', err);
    const same = await w.m.useLicense('pro');
    check('H11c', 'switching to the license that already runs changes nothing', same.tier === 'pro', 'low');
  }

  // H12: exclusive key = downgrade/refund, survives restart, new Premium key (newer) still works
  {
    const w = await mk();
    const premOld = issue({ tier: 'premium', plan: 'Y01', now: BASE });
    await w.m.activate(issue({ tier: 'pro', plan: 'Y01', now: BASE }).key);
    await w.m.activate(premOld.key);
    const excl = issue({ tier: 'pro', plan: 'Y01', now: BASE + 3 * DAY, exclusive: true });
    w.run(4 * DAY);
    const r = await tryActivate(w.m, excl.key);
    let st = await w.m.getStatus();
    check('H12', 'exclusive Pro key: Premium is removed, Pro runs', r.ok && st.tier === 'pro' && !lic(st, 'premium'), 'critical', JSON.stringify(st.licenses));
    await w.shutdown();
    await w.boot();
    const again = await tryActivate(w.m, premOld.key);
    check('H12b', 'after a restart the old Premium key is still refused', !again.ok && w.m.getTier() === 'pro', 'critical', JSON.stringify(again));
    const fresh = await tryActivate(w.m, issue({ tier: 'premium', plan: 'M30', now: BASE + 5 * DAY }).key);
    check('H12c', 'a NEW Premium key (issued after the exclusive one) is accepted', fresh.ok && w.m.getTier() === 'premium', 'high', JSON.stringify(fresh));
  }

  // H13: no way to gain days by toggling
  {
    const w = await mk();
    await w.m.activate(keyOf('pro', 'Y01', BASE));
    await w.m.activate(keyOf('premium', 'Y01', BASE));
    const total = (st) => st.licenses.reduce((a, l) => a + l.daysLeft, 0);
    const t0 = total(await w.m.getStatus());
    for (let i = 0; i < 100; i++) {
      await w.m.useLicense(i % 2 ? 'premium' : 'pro');
      w.run(2 * HOUR);
      await w.m.getStatus();
    }
    const t1 = total(await w.m.getStatus());
    const elapsedDays = (100 * 2 * HOUR) / DAY; // 8.3 days of real time
    check('H13', `100 switches over ${elapsedDays.toFixed(1)} days: the two licenses together lose about that much, never less (${t0} -> ${t1})`, t0 - t1 >= Math.floor(elapsedDays) - 2 && t0 - t1 <= Math.ceil(elapsedDays) + 4, 'critical', `${t0}->${t1}`);
  }

  // H14: clock tricks while a license is paused
  {
    const w = await mk();
    await w.m.activate(keyOf('pro', 'Y01', BASE));
    await w.m.activate(keyOf('premium', 'Y01', BASE));
    const before = lic(await w.m.getStatus(), 'pro').daysLeft;
    w.sys += 5 * 365 * DAY; // clock typed 5 years ahead
    await w.m.getStatus();
    w.sys -= 5 * 365 * DAY;
    await w.step(DAY, 6 * HOUR);
    const st = await w.m.getStatus();
    check('H14', 'PC clock +5 years while Pro is paused: Pro neither loses years nor gains days', lic(st, 'pro').daysLeft === before && st.tier === 'premium', 'high', JSON.stringify(st.licenses));
    w.sys -= 200 * DAY; // clock put back
    await w.step(2 * DAY, 6 * HOUR);
    const sw = await w.m.useLicense('pro');
    check('H14b', 'PC clock put back, then switching: Pro days do not increase', lic(sw, 'pro').daysLeft <= before, 'high', `${before} -> ${lic(sw, 'pro').daysLeft}`);
  }

  // H15: other-PC key, garbage, duplicates
  {
    const w = await mk();
    await w.m.activate(keyOf('pro', 'Y01', BASE));
    const wrong = await tryActivate(w.m, issue({ tier: 'premium', hw: '1111-2222-3333-4444' }).key);
    check('H15', 'a key for another PC is refused and the running license is untouched', !wrong.ok && w.m.getTier() === 'pro' && (await w.m.getStatus()).licenses.length === 1, 'critical');
    const dup = await tryActivate(w.m, keyOf('pro', 'Y01', BASE));
    check('H15b', 'entering the same key again is harmless', dup.ok && (await w.m.getStatus()).licenses.length === 1, 'low');
  }
  {
    const w = world();
    w.licenseText = JSON.stringify({ v: 2, keys: ['POS1.garbage', issue({ tier: 'pro' }).key, issue({ tier: 'pro', now: BASE - 10 * DAY }).key, 'x', issue({ tier: 'premium', hw: '1111-2222-3333-4444' }).key] });
    await w.boot();
    const st = await w.m.getStatus();
    check('H16', 'saved wallet with garbage / duplicate / foreign keys: only the valid newest key per tier is used', st.tier === 'pro' && st.licenses.length === 1 && !st.locked, 'high', JSON.stringify(st.licenses));
    const w2 = world();
    w2.licenseText = JSON.stringify({ v: 2, keys: ['nope', 'POS1.bad.bad'] });
    await w2.boot();
    const s2 = await w2.m.getStatus();
    check('H16b', 'wallet with only bad keys: locked, with a plain message', s2.locked && /not valid|not a valid|not recognised/.test(s2.message || ''), 'medium', s2.message);
  }

  // H17: old single-key file (before tiers/wallet) keeps working and a new key is added next to it
  {
    const legacyPayload = { v: 1, kid: '1', mid: HW, plan: 'Y01', cust: 'Old Customer', iat: Math.floor(BASE / 1000), exp: Math.floor((BASE + 300 * DAY) / 1000), epoch: 1 };
    const legacyKey = fmt.signPayload(fmt.LICENSE_PREFIX, fmt.LICENSE_DOMAIN, legacyPayload, kp.privateKey);
    const w = world();
    w.licenseText = legacyKey;
    await w.boot();
    let st = await w.m.getStatus();
    check('H17', 'existing customer with an old key (no tier): runs as Premium exactly as before', st.tier === 'premium' && st.licenses.length === 1 && st.licenses[0].slot === 'premium', 'critical', JSON.stringify(st));
    const r = await tryActivate(w.m, issue({ tier: 'premium', plan: 'Y01', now: BASE + 20 * DAY }).key);
    st = await w.m.getStatus();
    check('H17b', 'renewing an old key with a tiered Premium key replaces it (same slot), no pause, no gap', r.ok && st.licenses.length === 1 && st.tier === 'premium' && !st.locked, 'high', JSON.stringify(st.licenses));
    const w2 = world();
    w2.licenseText = legacyKey;
    await w2.boot();
    const rp = await tryActivate(w2.m, issue({ tier: 'pro', plan: 'Y01', now: BASE + 20 * DAY }).key);
    const s2 = await w2.m.getStatus();
    check('H17c', 'old key (Premium) + a new Pro key: Premium keeps running, Pro is saved', rp.ok && s2.tier === 'premium' && s2.licenses.length === 2, 'high', JSON.stringify(s2.licenses));
  }

  // H18: stored format stays readable by older builds when only one license exists
  {
    const w = await mk();
    await w.m.activate(keyOf('pro', 'Y01', BASE));
    const single = w.licenseText && w.licenseText.startsWith('POS1.');
    await w.m.activate(keyOf('premium', 'Y01', BASE));
    const both = w.licenseText && w.licenseText.startsWith('{');
    check('H18', 'one license is stored as the plain key (older builds can read it); two are stored as a small list', single && both, 'low', String(w.licenseText).slice(0, 20));
  }

  // H19: two activations racing (different tiers)
  {
    const w = await mk();
    const [a, b] = await Promise.all([tryActivate(w.m, keyOf('pro', 'Y01', BASE)), tryActivate(w.m, keyOf('premium', 'M30', BASE))]);
    const st = await w.m.getStatus();
    check('H19', 'Pro and Premium keys entered at the same moment: both saved, Premium runs', a.ok && b.ok && st.licenses.length === 2 && st.tier === 'premium', 'medium', JSON.stringify(st.licenses));
  }

  // H20: repair code drops a future-dated key but keeps the good one
  {
    const w = await mk();
    await w.m.activate(keyOf('pro', 'Y01', BASE));
    const badIat = BASE + 3 * 365 * DAY;
    await tryActivate(w.m, issue({ tier: 'premium', plan: 'M30', now: badIat }).key);
    const rr = await tryActivate(w.m, repairCode(BASE));
    const st = await w.m.getStatus();
    check('H20', 'repair code removes the key that was signed with a wrong (future) date and keeps the good one running', rr.ok && st.licenses.length === 1 && st.licenses[0].slot === 'pro' && st.tier === 'pro', 'high', JSON.stringify(st.licenses));
  }

  // H21: vendor side - renewal base is per tier, exclusive flag is in the key
  {
    const csv = 'issued_at,type,customer,hardware_id,plan,expires,kid,key,tier,exclusive\n' +
      `"2026-01-01T00:00:00Z","license","A","${HW}","Y01","2027-01-01","1","K1","pro",""\n` +
      `"2026-03-01T00:00:00Z","license","A","${HW}","M30","2026-04-01","1","K2","premium",""\n` +
      `"2025-01-01T00:00:00Z","license","A","${HW}","Y01","2026-01-01","1","K0","",""\n`;
    check('H21', 'vendor renewal finds the end of the SAME tier (pro 2027-01-01, premium 2026-04-01, old key without tier = premium)', tool.readLastExpiry(csv, HW, 'pro') === '2027-01-01' && tool.readLastExpiry(csv, HW, 'premium') === '2026-04-01', 'high', `${tool.readLastExpiry(csv, HW, 'pro')} ${tool.readLastExpiry(csv, HW, 'premium')}`);
    const ex = issue({ tier: 'pro', exclusive: true });
    const no = issue({ tier: 'pro' });
    check('H21b', 'issue tool: --exclusive puts excl=1 inside the signed key, normal keys do not', ex.payload.excl === 1 && no.payload.excl === undefined, 'medium');
  }

  // H23: the manual "customer list" tool
  {
    const { summarize } = R('tools/license/list-licenses');
    const csv = 'issued_at,type,customer,hardware_id,plan,expires,kid,key,tier,exclusive\n' +
      '"2026-01-01T00:00:00Z","license","Cafe A","AAAA-BBBB-CCCC-DDDD","Y01","2026-11-20","1","K","pro",""\n' +
      '"2026-05-01T00:00:00Z","license","Cafe A","AAAA-BBBB-CCCC-DDDD","Y01","2027-05-01","1","K","premium",""\n' +
      '"2025-01-01T00:00:00Z","license","Old Cafe","1111-2222-3333-4444","Y01","2026-01-01","1","K","",""\n' +
      '"2026-02-01T00:00:00Z","license","Cafe A","AAAA-BBBB-CCCC-DDDD","Y01","2026-12-01","1","K","pro",""\n' +
      '"2026-06-01T00:00:00Z","repair","","AAAA-BBBB-CCCC-DDDD","","","1","R","",""\n';
    const rows = summarize(csv, new Date('2026-11-18T00:00:00Z'));
    const proRow = rows.find((r) => r.tier === 'pro');
    check('H23', 'customer list: one row per PC and tier (newest key), repair codes ignored, old keys shown as legacy Premium, sorted by days left', rows.length === 3 && proRow.expires === '2026-12-01' && rows.find((r) => r.legacy && r.tier === 'premium' && r.status === 'ENDED') && rows[0].daysLeft <= rows[1].daysLeft && rows.find((r) => r.tier === 'premium' && !r.legacy).status === 'active', 'low', JSON.stringify(rows));
  }

  // H22: status shape for the screen
  {
    const w = await mk();
    await w.m.activate(keyOf('pro', 'Y01', BASE));
    await w.m.activate(keyOf('premium', 'M30', BASE));
    const st = await w.m.getStatus();
    const [prem, pro] = [lic(st, 'premium'), lic(st, 'pro')];
    check('H22', 'status lists each license with state, days, and whether it can be started', prem.current && prem.state === 'active' && !prem.canUse && !pro.current && pro.state === 'paused' && pro.canUse && pro.endsOn === null && typeof st.notice === 'string', 'medium', JSON.stringify(st.licenses));
  }
}


// ---------------------------------------------------------------- R. Forgot-PIN recovery (private/public key)
async function groupRecovery() {
  const rec = R('electron/security/masterKeyRecovery');
  const { issuePinReset } = R('tools/license/issue-pin-reset');
  const rk = crypto.generateKeyPairSync('ed25519');
  const keys = [{ kid: '1', pem: rk.publicKey.export({ type: 'spki', format: 'pem' }) }];
  const MID = 'AAAA-BBBB-CCCC-DDDD';
  const day = new Date('2026-11-17T10:00:00Z');
  const challenge = rec.generateChallenge(MID, day).challenge;
  const code = issuePinReset({ privateKey: rk.privateKey, challenge });
  const ok = (m, c, o = {}) => rec.verifyMasterKey(m, c, { keys, now: day, ...o });

  check('R01', 'challenge looks like A1B2-C3D4, is stable for the day, and differs per PC and per day', /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(challenge) && challenge === rec.generateChallenge(MID, new Date('2026-11-17T23:59:00Z')).challenge && challenge !== rec.generateChallenge('1111-2222-3333-4444', day).challenge && challenge !== rec.generateChallenge(MID, new Date('2026-11-18T00:01:00Z')).challenge, 'high');
  check('R02', 'the developer\'s signed reply unlocks that PC on that day', ok(MID, code) === true, 'critical');
  check('R03', 'the same reply does NOT work on another PC', ok('1111-2222-3333-4444', code) === false, 'critical');
  check('R04', 'the reply works until the end of the next day (midnight grace) and no longer', ok(MID, code, { now: new Date('2026-11-18T12:00:00Z') }) === true && ok(MID, code, { now: new Date('2026-11-19T00:30:00Z') }) === false, 'high');
  const sig = Buffer.from(code.slice(4), 'base64url');
  sig[5] ^= 1;
  check('R05', 'one changed bit in the reply makes it invalid', ok(MID, 'PR1.' + sig.toString('base64url')) === false, 'critical');
  const other = crypto.generateKeyPairSync('ed25519');
  check('R06', 'a reply signed by someone else\'s key is rejected', ok(MID, issuePinReset({ privateKey: other.privateKey, challenge })) === false, 'critical');
  check('R07', 'with NO recovery key configured nothing is ever accepted (not even a real signature)', ok(MID, code, { keys: [] }) === false && rec.verifyMasterKey(MID, code, { now: day }) === false, 'critical');
  const wrapped = ` \n${code.slice(0, 20)}\u200E${code.slice(20, 50)}\u200B\n  ${code.slice(50)}\u00A0`;
  check('R08', 'a reply pasted with line breaks / spaces / invisible direction marks still works', ok(MID, wrapped) === true, 'medium');
  let threw = false;
  for (const junk of [undefined, null, 0, {}, [], '', 'PR1.', 'PR1.abc', 'x'.repeat(100000), 'PR1.' + 'A'.repeat(86), 'MASTERKEY', 'A1B2C3D4E5', code.toLowerCase(), code.slice(1)]) {
    try { if (ok(MID, junk)) threw = true; } catch { threw = true; }
  }
  check('R09', 'garbage input never throws and is never accepted', !threw, 'high');
  // domain separation: other signatures made with the same key cannot be passed off as a PIN reset
  const raw = crypto.sign(null, Buffer.from(rec.normalizeChallenge(challenge)), rk.privateKey).toString('base64url');
  const asLicense = fmt.signPayload(fmt.LICENSE_PREFIX, fmt.LICENSE_DOMAIN, { ch: rec.normalizeChallenge(challenge) }, rk.privateKey);
  const asRepairSig = asLicense.split('.')[2];
  check('R10', 'a bare signature of the challenge, or a licence/repair signature, is not accepted as a PIN reset', !ok(MID, 'PR1.' + raw) && !ok(MID, 'PR1.' + asRepairSig) && !ok(MID, asLicense), 'critical');
  // the licence signing key must not be able to unlock PINs, and vice versa
  const licMsg = recMsgForLicenseKey();
  function recMsgForLicenseKey() { return issuePinReset({ privateKey: kp.privateKey, challenge }); }
  check('R11', 'the LICENCE private key cannot make a valid PIN reset (the two key pairs are separate)', ok(MID, licMsg) === false, 'critical');
  const src = fs.readFileSync(path.join(ROOT, 'electron/security/masterKeyRecovery.js'), 'utf8');
  check('R12', 'the app holds no recovery secret: no HMAC, no MASTER_SECRET, no generated secret file', !/createHmac|MASTER_SECRET|master-secret/.test(src), 'critical');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  check('R13', 'a successful recovery clears the old lock so a new one must be set', /verifyMasterKey\(machineId, candidateKey\)[\s\S]{0,120}clearLock\(\)/.test(mainSrc), 'high');
}

// ---------------------------------------------------------------- run
(async () => {
  for (const g of [groupCrypto, groupExpiry, groupClock, groupHardware, groupGate, groupVendor, groupTiers, groupWallet, groupRecovery]) {
    try {
      await g();
    } catch (e) {
      fail('critical', 'HARNESS', `group ${g.name} crashed`, e.stack);
    }
  }
  const order = { PASS: 0, LIMIT: 1, FAIL: 2 };
  const sevRank = { critical: 0, high: 1, medium: 2, low: 3, '': 4 };
  const fails = results.filter((r) => r.kind === 'FAIL').sort((a, b) => sevRank[a.sev] - sevRank[b.sev]);
  const limits = results.filter((r) => r.kind === 'LIMIT');
  const passes = results.filter((r) => r.kind === 'PASS');

  console.log(`\n==== LICENSING QA: ${passes.length} passed, ${fails.length} failed, ${limits.length} known limits measured ====\n`);
  for (const r of fails) console.log(`FAIL [${r.sev}] ${r.id}  ${r.title}${r.note ? `\n      ${r.note}` : ''}\n`);
  for (const r of limits) console.log(`LIMIT        ${r.id}  ${r.title}${r.note ? `\n      ${r.note}` : ''}\n`);
  if (process.argv.includes('--verbose')) for (const r of passes) console.log(`PASS         ${r.id}  ${r.title}`);
  process.exit(fails.some((f) => f.sev === 'critical') ? 2 : fails.length ? 1 : 0);
})();
