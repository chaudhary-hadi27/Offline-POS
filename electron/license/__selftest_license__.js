'use strict';

/**
 * Self-test for the licensing system (no Electron needed):
 *
 *     npm run db:test:license
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CH = require('../ipc-channels');
const { verifySigned, signPayload, LICENSE_PREFIX, LICENSE_DOMAIN, REPAIR_DOMAIN, REPAIR_PREFIX } = require('./licenseFormat');
const { createLicenseManager, isChannelAllowedWhenLocked } = require('./licenseManager');
const { getHardwareId, parseMachineGuid, hashToHardwareId } = require('./hardwareId');
const { createLicenseFiles } = require('./licenseStorage');
const { latestOrderMs } = require('./evidence');
const { computeExpirySeconds, issueLicense, issueRepair, loadPrivateKey, readLastExpiry } = require('../../tools/license/licenseTool');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const DAY = 86400000;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `${p}-`));
const HW = 'A1B2-C3D4-E5F6-7890';
const OTHER_HW = '1111-2222-3333-4444';

// vendor key pair (what generate-keys.js would make) + a second, unrelated one
const vendor = crypto.generateKeyPairSync('ed25519');
const attacker = crypto.generateKeyPairSync('ed25519');
const vendorPem = vendor.publicKey.export({ type: 'spki', format: 'pem' });
const PUBLIC_KEYS = [{ kid: '1', pem: vendorPem }];

/** in-memory clock-memory store (poke() lets a test plant arbitrary - even garbage - saved values) */
function memStore() {
  let data = null;
  return {
    async read() {
      return data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : data;
    },
    async write(obj) {
      data = { ...obj };
    },
    peek: () => data,
    poke(obj) {
      data = obj;
    },
    wipe() {
      data = null;
    },
  };
}

/** A controllable clock: `sys` is the PC clock, `mono` is real elapsed running time. */
function makeClock(start) {
  const c = { sys: start, mono: 0 };
  c.tick = (ms) => {
    c.sys += ms;
    c.mono += ms;
  }; // real time passes while the POS runs
  c.jump = (ms) => {
    c.sys += ms;
  }; // someone changes the PC clock (forward: +, back: -)
  c.off = (ms, shownAs = ms) => {
    c.sys += shownAs;
    c.mono += 0;
  }; // POS switched off for `ms` of real time; the PC clock then shows `shownAs` later
  return c;
}

function setup({ clk, orderMs = { v: null }, devBypass = false, stores, files, publicKeys = PUBLIC_KEYS } = {}) {
  const clockStores = stores || [memStore(), memStore(), memStore()];
  const licenseFiles = files || createLicenseFiles({ userDataDir: tmp('lic-ud'), secondaryDir: tmp('lic-2nd') });
  const mgr = createLicenseManager({
    getHardwareId: async () => ({ id: HW, source: 'machine-guid' }),
    publicKeys,
    minEpoch: 1,
    licenseFiles,
    clockStores,
    getLatestOrderMs: () => orderMs.v,
    now: () => clk.sys,
    mono: () => clk.mono,
    devBypass,
  });
  return { mgr, clockStores, licenseFiles, orderMs };
}

const mint = (over = {}) =>
  issueLicense({ privateKey: vendor.privateKey, kid: '1', hardwareId: HW, customer: 'A1 Bite', plan: 'Y01', ...over });

(async () => {
  const T0 = Date.UTC(2026, 9, 26, 10, 0, 0); // 26 Oct 2026

  // ------------------------------------------------------------ signatures
  await test('a license signed by the vendor verifies; a tampered one does not', () => {
    const { key } = mint({ now: new Date(T0) });
    assert.ok(key.startsWith(LICENSE_PREFIX));
    assert.strictEqual(verifySigned(key, 'license', PUBLIC_KEYS).ok, true);

    // flip the expiry inside the payload (try to give yourself 10 more years)
    const [, payloadB64, sigB64] = key.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    payload.exp += 10 * 365 * 86400;
    const forged = `${LICENSE_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sigB64}`;
    assert.strictEqual(verifySigned(forged, 'license', PUBLIC_KEYS).reason, 'bad-signature');
  });

  await test('a key signed with someone else\'s private key is rejected, as is an unknown key id', () => {
    const forged = signPayload(LICENSE_PREFIX, LICENSE_DOMAIN, { v: 1, kid: '1', mid: HW, plan: 'Y10', cust: 'x', iat: 1, exp: 4e9, epoch: 1 }, attacker.privateKey);
    assert.strictEqual(verifySigned(forged, 'license', PUBLIC_KEYS).reason, 'bad-signature');
    const other = signPayload(LICENSE_PREFIX, LICENSE_DOMAIN, { v: 1, kid: '99', mid: HW, exp: 4e9, epoch: 1 }, vendor.privateKey);
    assert.strictEqual(verifySigned(other, 'license', PUBLIC_KEYS).reason, 'unknown-key');
  });

  await test('line-wrapped / spaced pasting still works; garbage and truncation are rejected', () => {
    const { key } = mint({ now: new Date(T0) });
    const wrapped = key.replace(/(.{60})/g, '$1\n  ');
    assert.strictEqual(verifySigned(wrapped, 'license', PUBLIC_KEYS).ok, true);
    assert.strictEqual(verifySigned(key.slice(0, -10), 'license', PUBLIC_KEYS).ok, false);
    assert.strictEqual(verifySigned('hello', 'license', PUBLIC_KEYS).reason, 'malformed');
  });

  await test('a license cannot be replayed as a repair code, or the other way round', () => {
    const lic = mint({ now: new Date(T0) }).key;
    assert.strictEqual(verifySigned(lic.replace(LICENSE_PREFIX, REPAIR_PREFIX), 'repair', PUBLIC_KEYS).ok, false);
    const rep = issueRepair({ privateKey: vendor.privateKey, hardwareId: HW, now: new Date(T0) }).key;
    assert.strictEqual(verifySigned(rep.replace(REPAIR_PREFIX, LICENSE_PREFIX), 'license', PUBLIC_KEYS).ok, false);
  });

  // ----------------------------------------------------------- plan / dates
  await test('plan durations: M30, Y01, Y03, Y10, leap day, CUSTOM, renewal', () => {
    const from = new Date(Date.UTC(2026, 9, 26, 15, 0, 0));
    const ymd = (s) => new Date(s * 1000).toISOString();
    assert.strictEqual(ymd(computeExpirySeconds({ plan: 'M30', from })), '2026-11-25T23:59:59.000Z');
    assert.strictEqual(ymd(computeExpirySeconds({ plan: 'Y01', from })), '2027-10-26T23:59:59.000Z');
    assert.strictEqual(ymd(computeExpirySeconds({ plan: 'Y03', from })), '2029-10-26T23:59:59.000Z');
    assert.strictEqual(ymd(computeExpirySeconds({ plan: 'Y10', from })), '2036-10-26T23:59:59.000Z');
    assert.strictEqual(ymd(computeExpirySeconds({ plan: 'Y01', from: new Date(Date.UTC(2028, 1, 29)) })), '2029-02-28T23:59:59.000Z');
    assert.strictEqual(ymd(computeExpirySeconds({ plan: 'CUSTOM', from, expires: '2027-03-31' })), '2027-03-31T23:59:59.000Z');
    assert.throws(() => computeExpirySeconds({ plan: 'CUSTOM', from, expires: '2020-01-01' }), /past/);
    assert.throws(() => computeExpirySeconds({ plan: 'CUSTOM', from, expires: '31/03/2027' }), /look like/);
    assert.throws(() => computeExpirySeconds({ plan: 'FOREVER', from }), /Unknown plan/);
    // renewal: counting starts from the current expiry day, so unused days are kept
    const renewalFrom = new Date(Date.UTC(2027, 0, 15));
    assert.strictEqual(ymd(computeExpirySeconds({ plan: 'Y01', from: renewalFrom })), '2028-01-15T23:59:59.000Z');
  });

  await test('bad hardware ids and missing customer are refused when issuing', () => {
    assert.throws(() => issueLicense({ privateKey: vendor.privateKey, hardwareId: 'nope', customer: 'x', plan: 'M30' }), /Hardware ID/);
    assert.throws(() => issueLicense({ privateKey: vendor.privateKey, hardwareId: HW, customer: ' ', plan: 'M30' }), /name is required/);
  });

  // ----------------------------------------------------------- activation
  await test('first boot is locked; a valid key unlocks it; status shows plan, customer, days left', async () => {
    const clk = makeClock(T0);
    const { mgr } = setup({ clk });
    const s0 = await mgr.init();
    assert.strictEqual(s0.state, 'unlicensed');
    assert.strictEqual(s0.locked, true);
    assert.strictEqual(mgr.isLocked(), true);
    assert.strictEqual(s0.hardwareId, HW);

    const s1 = await mgr.activate(mint({ now: new Date(T0) }).key);
    assert.strictEqual(s1.state, 'active');
    assert.strictEqual(s1.locked, false);
    assert.strictEqual(s1.plan, 'Y01');
    assert.strictEqual(s1.customer, 'A1 Bite');
    assert.strictEqual(s1.daysLeft, 366);
    assert.strictEqual(mgr.isLocked(), false);
  });

  await test('a key for another PC, an expired key and a malformed key are refused with clear messages', async () => {
    const clk = makeClock(T0);
    const { mgr } = setup({ clk });
    await mgr.init();
    await assert.rejects(() => mgr.activate(mint({ hardwareId: OTHER_HW, now: new Date(T0) }).key), /different PC/);
    await assert.rejects(() => mgr.activate(mint({ plan: 'CUSTOM', expires: '2026-10-25', now: new Date(T0 - 2 * DAY), from: new Date(T0 - 2 * DAY) }).key), /expired/);
    await assert.rejects(() => mgr.activate('POS1.abc.def'), /not valid|valid license/);
    await assert.rejects(() => mgr.activate('random text'), /does not look like a license key/);
    await assert.rejects(() => mgr.activate(''), /Paste the license key/);
    assert.strictEqual(mgr.isLocked(), true);
  });

  await test('the license survives losing its main file, and is re-created from the second copy', async () => {
    const clk = makeClock(T0);
    const files = createLicenseFiles({ userDataDir: tmp('lic-ud'), secondaryDir: tmp('lic-2nd') });
    const a = setup({ clk, files });
    await a.mgr.init();
    await a.mgr.activate(mint({ now: new Date(T0) }).key);
    fs.rmSync(files.primary); // "delete the app's data folder"
    const b = setup({ clk, files, stores: a.clockStores });
    const s = await b.mgr.init();
    assert.strictEqual(s.state, 'active');
    assert.ok(fs.existsSync(files.primary), 'main copy healed');
  });

  await test('a saved license for a DIFFERENT PC (e.g. Windows reinstalled) is reported as invalid, not silently ignored', async () => {
    const clk = makeClock(T0);
    const files = createLicenseFiles({ userDataDir: tmp('lic-ud'), secondaryDir: tmp('lic-2nd') });
    await files.save(mint({ hardwareId: OTHER_HW, now: new Date(T0) }).key);
    const s = await setup({ clk, files }).mgr.init();
    assert.strictEqual(s.state, 'invalid');
    assert.ok(/different PC/.test(s.message) && s.message.includes(HW));
    assert.strictEqual(s.locked, true);
  });

  // ------------------------------------------------------------- renewing
  await test('a NEW license replaces the current one at once - the POS is never locked in between', async () => {
    const clk = makeClock(T0);
    const { mgr } = setup({ clk });
    await mgr.init();
    await mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(10 * DAY);
    await mgr.getStatus();
    assert.strictEqual(mgr.isLocked(), false);

    const lockedAt = [];
    const renewal = mint({ plan: 'Y01', now: new Date(T0 + 10 * DAY), from: new Date(T0 + 20 * DAY) }); // keeps the unused 20 days
    const p = mgr.activate(renewal.key);
    lockedAt.push(mgr.isLocked()); // while the activation is still in flight
    const s = await p;
    lockedAt.push(mgr.isLocked());
    assert.deepStrictEqual(lockedAt, [false, false], 'no locked moment at any point');
    assert.strictEqual(s.plan, 'Y01');
    assert.ok(s.daysLeft > 370, `old term's unused days are kept, got ${s.daysLeft}`);
  });

  await test('an expired POS unlocks the moment a new key is entered', async () => {
    const clk = makeClock(T0);
    const { mgr } = setup({ clk });
    await mgr.init();
    await mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(35 * DAY);
    assert.strictEqual((await mgr.getStatus()).state, 'expired');
    assert.strictEqual(mgr.isLocked(), true);
    const s = await mgr.activate(mint({ plan: 'Y01', now: new Date(T0 + 35 * DAY) }).key);
    assert.strictEqual(s.state, 'active');
    assert.strictEqual(mgr.isLocked(), false);
  });

  await test('an OLDER key can never replace a newer one; a later key (even a shorter one the vendor chose to issue) can', async () => {
    const clk = makeClock(T0);
    const { mgr } = setup({ clk });
    await mgr.init();
    await mgr.activate(mint({ plan: 'Y03', now: new Date(T0) }).key);
    const stale = mint({ plan: 'Y10', now: new Date(T0 - 5 * DAY) }).key;
    await assert.rejects(() => mgr.activate(stale), /older than the license already on this PC/);
    const corrected = await mgr.activate(mint({ plan: 'Y01', now: new Date(T0 + 1 * DAY) }).key);
    assert.strictEqual(corrected.plan, 'Y01');
  });

  await test('the license epoch raises the bar: an old-epoch license is refused by a build that requires a newer one', async () => {
    const clk = makeClock(T0);
    const m = createLicenseManager({
      getHardwareId: async () => ({ id: HW, source: 'machine-guid' }),
      publicKeys: PUBLIC_KEYS,
      minEpoch: 2,
      clockStores: [memStore()],
      now: () => clk.sys,
      mono: () => clk.mono,
    });
    await m.init();
    await assert.rejects(() => m.activate(mint({ epoch: 1, now: new Date(T0) }).key), /older version/);
    const s = await m.activate(mint({ epoch: 2, now: new Date(T0) }).key);
    assert.strictEqual(s.state, 'active');
  });

  // --------------------------------------------------------------- expiry
  await test('when the license runs out the POS locks; 7-day warning appears before that', async () => {
    const clk = makeClock(T0);
    const { mgr } = setup({ clk });
    await mgr.init();
    await mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(20 * DAY);
    let s = await mgr.getStatus();
    assert.strictEqual(s.state, 'active');
    assert.strictEqual(s.expiringSoon, false);
    clk.tick(5 * DAY);
    s = await mgr.getStatus();
    assert.strictEqual(s.expiringSoon, true);
    assert.ok(/expires in/.test(s.message));
    clk.tick(7 * DAY);
    assert.strictEqual(mgr.isLocked(), true, 'the cheap per-request check notices expiry even before the next refresh');
    s = await mgr.getStatus();
    assert.strictEqual(s.state, 'expired');
    assert.strictEqual(s.locked, true);
  });

  // ------------------------------------- the PC clock can never break the POS
  await test('PC clock put BACK: gains nothing (running time still counts), nothing breaks, owner is told', async () => {
    const clk = makeClock(T0);
    const { mgr } = setup({ clk });
    await mgr.init();
    await mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(20 * DAY);
    const before = await mgr.getStatus();
    clk.jump(-18 * DAY); // cheat: put the clock back 18 days
    clk.tick(2 * DAY); // two more real days pass
    const after = await mgr.getStatus();
    assert.strictEqual(after.state, 'active');
    assert.strictEqual(after.daysLeft, before.daysLeft - 2, 'the 2 real days counted, the rolled-back days did not give anything back');
    assert.ok(after.clockWarning, 'owner is told the PC date looks wrong');
  });

  await test('PC clock set far FORWARD while the POS runs (typed 2035): the POS carries on, and fixing the date later is harmless', async () => {
    const clk = makeClock(T0);
    const { mgr } = setup({ clk });
    await mgr.init();
    await mgr.activate(mint({ plan: 'Y01', now: new Date(T0) }).key);
    clk.tick(3 * DAY);
    const d0 = (await mgr.getStatus()).daysLeft;

    clk.jump(Date.UTC(2035, 5, 1) - clk.sys); // 9 years forward
    clk.tick(60 * 60 * 1000);
    const during = await mgr.getStatus();
    assert.strictEqual(during.state, 'active', 'no lock, no repair code needed');
    assert.strictEqual(mgr.isLocked(), false);
    assert.ok(during.daysLeft >= d0 - 8, `at most ~a week was believed, got ${d0 - during.daysLeft} days lost`);
    assert.ok(during.clockWarning);

    // the date is corrected (back to the real date, which is "earlier" than 2035)
    clk.jump(T0 + 3 * DAY + 60 * 60 * 1000 - clk.sys);
    clk.tick(60 * 60 * 1000);
    const fixed = await mgr.getStatus();
    assert.strictEqual(fixed.state, 'active');
    assert.ok(fixed.daysLeft >= d0 - 8 && fixed.daysLeft <= d0, 'still fine after the fix');
  });

  await test('PC clock wrong while the POS is switched OFF (boots in 2035): still active, at most ~a week believed', async () => {
    const clk = makeClock(T0);
    const a = setup({ clk });
    await a.mgr.init();
    await a.mgr.activate(mint({ plan: 'Y01', now: new Date(T0) }).key);
    clk.tick(2 * DAY);
    const d0 = (await a.mgr.getStatus()).daysLeft;
    await a.mgr.flush();

    clk.off(0, Date.UTC(2035, 0, 1) - clk.sys); // closed; next start shows 2035
    const b = setup({ clk, files: a.licenseFiles, stores: a.clockStores });
    const s = await b.mgr.init();
    assert.strictEqual(s.state, 'active');
    assert.ok(s.daysLeft >= d0 - 8, `lost ${d0 - s.daysLeft} days`);
  });

  await test('dead CMOS battery (PC boots in 2009): the POS keeps running and counting; when the date is fixed nothing goes wrong', async () => {
    const clk = makeClock(T0);
    const a = setup({ clk });
    await a.mgr.init();
    await a.mgr.activate(mint({ plan: 'Y01', now: new Date(T0) }).key);
    clk.tick(5 * DAY);
    const d0 = (await a.mgr.getStatus()).daysLeft;
    await a.mgr.flush();

    clk.off(0, Date.UTC(2009, 0, 1) - clk.sys); // PC off, battery dies, boots in 2009
    const b = setup({ clk, files: a.licenseFiles, stores: a.clockStores });
    let s = await b.mgr.init();
    assert.strictEqual(s.state, 'active');
    assert.strictEqual(s.locked, false);
    assert.ok(s.clockWarning);
    clk.tick(1 * DAY); // a real day of use, PC still says 2009
    s = await b.mgr.getStatus();
    assert.strictEqual(s.daysLeft, d0 - 1, 'real running time still counts');

    // owner notices and corrects the date (real date is now about d0-2 days into the term)
    clk.jump(T0 + 7 * DAY - clk.sys);
    clk.tick(60 * 1000);
    s = await b.mgr.getStatus();
    assert.strictEqual(s.state, 'active');
    assert.ok(Math.abs(s.daysLeft - (d0 - 2)) <= 1, `calendar re-aligned, got ${s.daysLeft}`);
    assert.strictEqual(s.clockWarning, null);
  });

  await test('a license issued in the real present lifts a wrong (past) POS calendar: fresh PC with a 2009 clock still gets its full term', async () => {
    const clk = makeClock(Date.UTC(2009, 0, 1)); // brand-new install on a PC whose clock is in 2009
    const { mgr } = setup({ clk });
    await mgr.init();
    const s = await mgr.activate(mint({ plan: 'Y01', now: new Date(T0) }).key);
    assert.strictEqual(s.state, 'active');
    assert.strictEqual(s.daysLeft, 366, 'neither a lost year nor 17 free years');
  });

  await test('POS switched off for weeks, then started with the right date: only about a week of "off" time is counted (customer-friendly)', async () => {
    const clk = makeClock(T0);
    const a = setup({ clk });
    await a.mgr.init();
    await a.mgr.activate(mint({ plan: 'Y01', now: new Date(T0) }).key);
    const d0 = (await a.mgr.getStatus()).daysLeft;
    await a.mgr.flush();
    clk.off(0, 40 * DAY); // closed for renovation: 40 days
    const b = setup({ clk, files: a.licenseFiles, stores: a.clockStores });
    const s = await b.mgr.init();
    assert.strictEqual(s.daysLeft, d0 - 7);
  });

  await test('the calendar is remembered in several places: losing one copy changes nothing', async () => {
    const clk = makeClock(T0);
    const a = setup({ clk });
    await a.mgr.init();
    await a.mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(25 * DAY);
    await a.mgr.getStatus();
    await a.mgr.flush();
    a.clockStores[0].wipe();
    const b = setup({ clk, files: a.licenseFiles, stores: a.clockStores });
    const s = await b.mgr.init();
    assert.ok(s.daysLeft <= 6 && s.daysLeft >= 5, `still about 5 days left, got ${s.daysLeft}`);
  });

  await test('wiping EVERY copy of the calendar and putting the clock back is caught by the newest order (up to 10 days back)', async () => {
    const clk = makeClock(T0);
    const orderMs = { v: null };
    const a = setup({ clk, orderMs });
    await a.mgr.init();
    await a.mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(31 * DAY);
    orderMs.v = clk.sys;
    assert.strictEqual((await a.mgr.getStatus()).state, 'expired');

    a.clockStores.forEach((st) => st.wipe());
    clk.jump(-8 * DAY); // PC clock back 8 days
    const b = setup({ clk, orderMs, files: a.licenseFiles });
    const s = await b.mgr.init();
    assert.strictEqual(s.state, 'expired', 'the newest order still proves the real date');
  });

  await test('EDITING the saved calendar (every copy) back in time does nothing while the database holds newer orders', async () => {
    const clk = makeClock(T0);
    const orderMs = { v: null };
    const a = setup({ clk, orderMs });
    await a.mgr.init();
    await a.mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(40 * DAY);
    orderMs.v = clk.sys;
    assert.strictEqual((await a.mgr.getStatus()).state, 'expired');
    await a.mgr.flush();

    for (const edit of [{ T: T0 + DAY, S: T0 + DAY }, { T: 0, S: 0 }, { T: -1, S: -1 }]) {
      a.clockStores.forEach((st) => st.poke({ ...edit, lastRepair: 0 }));
      const s = await setup({ clk, orderMs, files: a.licenseFiles, stores: a.clockStores }).mgr.init();
      assert.strictEqual(s.state, 'expired', `edit ${JSON.stringify(edit)} must not revive the license`);
    }
  });

  await test('corrupt saved calendar values (text, negative, NaN, astronomical) are ignored: the POS still starts and is not locked', async () => {
    for (const rec of [{ T: 'abc', S: 'x' }, { T: -5, S: -5 }, { T: NaN, S: NaN }, { T: 1e18, S: 1e18 }, { T: null }, 'garbage', [] ]) {
      const clk = makeClock(T0);
      const a = setup({ clk });
      await a.mgr.init();
      await a.mgr.activate(mint({ plan: 'Y01', now: new Date(T0) }).key);
      a.clockStores.forEach((st) => st.poke(rec));
      const s = await setup({ clk, files: a.licenseFiles, stores: a.clockStores }).mgr.init();
      assert.strictEqual(s.state, 'active', `${JSON.stringify(rec)} -> ${s.state}`);
      assert.strictEqual(s.daysLeft, 366);
    }
  });

  await test('orders taken while the clock was a few days wrong cost at most ~10 days; far-off clocks cost nothing', async () => {
    const orderMs = { v: null };
    const run = async (aheadDays) => {
      const clk = makeClock(T0);
      const a = setup({ clk, orderMs });
      await a.mgr.init();
      await a.mgr.activate(mint({ plan: 'Y01', now: new Date(T0) }).key);
      clk.tick(1 * DAY);
      const d0 = (await a.mgr.getStatus()).daysLeft;
      orderMs.v = clk.sys + aheadDays * DAY; // an order stamped by a wrong clock
      const s = await a.mgr.getStatus();
      return d0 - s.daysLeft;
    };
    assert.ok((await run(3)) <= 3);
    assert.ok((await run(9)) <= 10);
    assert.strictEqual(await run(60), 0, 'an order stamped 60 days ahead is not believed');
    assert.strictEqual(await run(3000), 0);
  });

  await test('an order created while the clock was wildly wrong (2035) is NOT believed once the clock is right', async () => {
    const clk = makeClock(T0);
    const orderMs = { v: Date.UTC(2035, 5, 1) };
    const { mgr } = setup({ clk, orderMs });
    await mgr.init();
    const s = await mgr.activate(mint({ plan: 'Y01', now: new Date(T0) }).key);
    assert.strictEqual(s.state, 'active');
    assert.strictEqual(s.daysLeft, 366);
  });

  // --------------------------------------------------------- repair codes
  await test('a vendor repair code re-aligns the POS calendar to the real date (e.g. after several accidental clock jumps)', async () => {
    const clk = makeClock(T0);
    const { mgr } = setup({ clk });
    await mgr.init();
    await mgr.activate(mint({ plan: 'Y01', now: new Date(T0) }).key);
    clk.tick(1 * DAY);
    const d0 = (await mgr.getStatus()).daysLeft;

    // three accidental forward jumps while running: each believed up to a week
    for (let i = 0; i < 3; i++) {
      clk.jump(100 * DAY);
      clk.tick(60 * 60 * 1000);
      await mgr.getStatus();
      clk.jump(-100 * DAY);
      clk.tick(60 * 60 * 1000);
      await mgr.getStatus(); // the POS notices the clock came back before the next accident
    }
    const drifted = await mgr.getStatus();
    assert.ok(drifted.daysLeft <= d0 - 14, `the POS calendar drifted ahead by ${d0 - drifted.daysLeft} days`);

    clk.jump(T0 + 1 * DAY + 3 * 60 * 60 * 1000 - clk.sys); // owner sets the PC date correctly
    const repair = issueRepair({ privateKey: vendor.privateKey, hardwareId: HW, now: new Date(clk.sys) }).key;
    const s = await mgr.activate(repair);
    assert.strictEqual(s.state, 'active');
    assert.ok(Math.abs(s.daysLeft - d0) <= 1, `back in line, got ${s.daysLeft} vs ${d0}`);
    assert.strictEqual(s.clockWarning, null);
  });

  await test('repair codes are machine-bound, single-use and only accepted when the PC date is right', async () => {
    const clk = makeClock(T0);
    const { mgr } = setup({ clk });
    await mgr.init();
    await mgr.activate(mint({ now: new Date(T0) }).key);
    const wrongPc = issueRepair({ privateKey: vendor.privateKey, hardwareId: OTHER_HW, now: new Date(T0) }).key;
    await assert.rejects(() => mgr.activate(wrongPc), /different PC/);

    const farOff = issueRepair({ privateKey: vendor.privateKey, hardwareId: HW, now: new Date(T0 - 10 * DAY) }).key;
    await assert.rejects(() => mgr.activate(farOff), /date and time correctly/);

    const good = issueRepair({ privateKey: vendor.privateKey, hardwareId: HW, now: new Date(T0) }).key;
    await mgr.activate(good);
    await assert.rejects(() => mgr.activate(good), /already used/);
  });

  await test('a repair code can NOT be used to cheat an expiry (it carries the vendor\'s real date)', async () => {
    const clk = makeClock(T0);
    const { mgr } = setup({ clk });
    await mgr.init();
    await mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(40 * DAY);
    assert.strictEqual((await mgr.getStatus()).state, 'expired');
    const repair = issueRepair({ privateKey: vendor.privateKey, hardwareId: HW, now: new Date(clk.sys) }).key;
    const s = await mgr.activate(repair);
    assert.strictEqual(s.state, 'expired');
  });

  // ------------------------------------------------------------ dev & misc
  await test('development bypass and a build with no public key', async () => {
    const dev = setup({ clk: makeClock(T0), devBypass: true });
    const s = await dev.mgr.init();
    assert.strictEqual(s.locked, false);
    assert.strictEqual(dev.mgr.isLocked(), false);

    const none = setup({ clk: makeClock(T0), publicKeys: [] });
    const s2 = await none.mgr.init();
    assert.strictEqual(s2.locked, true);
    assert.ok(/not configured/.test(s2.message));
  });

  await test('while locked only Settings, the lock screen, printers, Danger Zone, Backup and License calls are allowed', () => {
    const allowed = [CH.SETTINGS_GET_ALL, CH.SETTINGS_SET, CH.SECURITY_SET_LOCK, CH.SECURITY_VERIFY, CH.PRINTER_LIST_PRINTERS, CH.ORDER_DANGER_COUNT, CH.ORDER_DANGER_DELETE, CH.BACKUP_GET_STATUS, CH.BACKUP_RESTORE, CH.LICENSE_GET_STATUS, CH.LICENSE_ACTIVATE];
    const blocked = [CH.ORDER_CREATE, CH.ORDER_LIST_BY_RANGE, CH.ITEM_LIST, CH.ITEM_CREATE, CH.CUSTOMER_LIST, CH.ANALYTICS_GET_SUMMARY, CH.ORDER_LIST_DELETED, CH.ORDER_HARD_DELETE, CH.PRINTER_PRINT_RECEIPT, CH.WHATSAPP_START_CAMPAIGN, CH.SHIFT_OPEN];
    allowed.forEach((c) => assert.ok(isChannelAllowedWhenLocked(c, CH), `should allow ${c}`));
    blocked.forEach((c) => assert.ok(!isChannelAllowedWhenLocked(c, CH), `should block ${c}`));
  });

  // -------------------------------------------------------- hardware id
  await test('hardware id: stable, formatted, derived from the Windows MachineGuid / Linux machine-id, fallback to the per-install file', async () => {
    const regOut = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    4C4C4544-0042-4E10-8053-B3C04F4D4B32\r\n\r\n';
    assert.strictEqual(parseMachineGuid(regOut), '4C4C4544-0042-4E10-8053-B3C04F4D4B32');
    const win = await getHardwareId({ userDataDir: tmp('hw'), platform: 'win32', run: async () => regOut });
    assert.strictEqual(win.source, 'machine-guid');
    assert.ok(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(win.id));
    assert.strictEqual(win.id, hashToHardwareId('4c4c4544-0042-4e10-8053-b3c04f4d4b32'), 'case-insensitive');
    const again = await getHardwareId({ userDataDir: tmp('other-data-dir'), platform: 'win32', run: async () => regOut });
    assert.strictEqual(again.id, win.id, 'does not depend on the app data folder');

    const linux = await getHardwareId({ userDataDir: tmp('hw'), platform: 'linux', readFile: async () => 'abcdef0123456789abcdef0123456789\n' });
    assert.strictEqual(linux.source, 'machine-id');

    const dir = tmp('hw-fallback');
    const fb1 = await getHardwareId({ userDataDir: dir, platform: 'win32', run: async () => { throw new Error('reg blocked'); } });
    assert.strictEqual(fb1.source, 'file');
  });

  // ------------------------------------------- evidence from a real DB
  await test('newest order time is read from the real database (including hidden orders)', () => {
    const { initDatabase, getDb, closeDatabase } = require('../database/db');
    initDatabase(tmp('lic-db'));
    const db = getDb();
    assert.strictEqual(latestOrderMs(db), null);
    db.prepare("INSERT INTO shifts (opened_by, opening_float) VALUES ('t', 0)").run();
    const ins = db.prepare("INSERT INTO orders (shift_id, order_type, subtotal, tax_rate, tax_amount, total, status, created_at, deleted_at) VALUES (1, 'Takeaway', 1, 0, 0, 1, 'COMPLETED', ?, ?)");
    ins.run('2026-10-20 08:00:00', null);
    ins.run('2026-10-25 21:30:15', '2026-10-26 00:00:00'); // hidden, but still proves the date
    assert.strictEqual(latestOrderMs(db), Date.UTC(2026, 9, 25, 21, 30, 15));
    closeDatabase();
  });

  // --------------------------------------------- the real command-line tool
  await test('issue-license.js (the command-line tool) produces keys the app accepts, and records them', () => {
    const dir = tmp('lic-tool');
    const pass = 'correct horse battery staple';
    const priv = vendor.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: pass });
    fs.writeFileSync(path.join(dir, 'private-1.pem'), priv);
    const script = path.join(__dirname, '..', '..', 'tools', 'license', 'issue-license.js');
    const env = { ...process.env, LICENSE_PASSPHRASE: pass };

    const lic = spawnSync(process.execPath, [script, '--dir', dir, '--machine', HW, '--customer', 'Cafe "Quote" Test', '--plan', 'Y03'], { env, encoding: 'utf8' });
    assert.strictEqual(lic.status, 0, lic.stderr);
    const key = lic.stdout.split('\n').find((l) => l.startsWith(LICENSE_PREFIX));
    const v = verifySigned(key, 'license', PUBLIC_KEYS);
    assert.ok(v.ok);
    assert.strictEqual(v.payload.plan, 'Y03');
    assert.strictEqual(v.payload.cust, 'Cafe "Quote" Test');

    // renewal: --renew finds the current expiry in the record and keeps unused days
    const renew = spawnSync(process.execPath, [script, '--dir', dir, '--machine', HW, '--customer', 'Cafe "Quote" Test', '--plan', 'Y01', '--renew'], { env, encoding: 'utf8' });
    assert.strictEqual(renew.status, 0, renew.stderr);
    assert.ok(/Renewal: the current license for this PC ends/.test(renew.stdout));
    const renewed = verifySigned(renew.stdout.split('\n').find((l) => l.startsWith(LICENSE_PREFIX)), 'license', PUBLIC_KEYS).payload;
    assert.ok(renewed.exp > v.payload.exp + 360 * 86400, 'the new term starts at the end of the current one');

    const rep = spawnSync(process.execPath, [script, '--dir', dir, '--repair', '--machine', HW], { env, encoding: 'utf8' });
    assert.strictEqual(rep.status, 0, rep.stderr);
    assert.ok(rep.stdout.split('\n').some((l) => l.startsWith(REPAIR_PREFIX)));

    const csv = fs.readFileSync(path.join(dir, 'issued-licenses.csv'), 'utf8').trim().split('\n');
    assert.strictEqual(csv.length, 4, 'header + 3 records');

    const bad = spawnSync(process.execPath, [script, '--dir', dir, '--machine', HW, '--customer', 'x', '--plan', 'Y01'], { env: { ...process.env, LICENSE_PASSPHRASE: 'wrong passphrase!!' }, encoding: 'utf8' });
    assert.notStrictEqual(bad.status, 0);
    assert.ok(/wrong passphrase/.test(bad.stderr));
    assert.ok(loadPrivateKey(priv, pass));
  });

  console.log(`\n${passed} license checks passed.`);
})().catch((err) => {
  console.error('\nLICENSE SELF-TEST FAILED:', err);
  process.exit(1);
});
