'use strict';

/**
 * RED TEAM for the license clock. Not a pass/fail test - it plays the cheating
 * customer and prints, for each attack, whether the design held ([BLOCKED]) or
 * whether the attacker gained something ([LOOPHOLE]) and how much.
 *
 *     npm run license:redteam
 *
 * Every attack is run against the real licenseManager with a simulated PC clock,
 * simulated "real running time" and in-memory copies of the stored calendar.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLicenseManager } = require('./licenseManager');
const { createLicenseFiles } = require('./licenseStorage');
const { issueLicense, issueRepair } = require('../../tools/license/licenseTool');

const DAY = 86400000;
const HOUR = 3600000;
const HW = 'A1B2-C3D4-E5F6-7890';
const T0 = Date.UTC(2026, 9, 26, 10, 0, 0);
const vendor = crypto.generateKeyPairSync('ed25519');
const PUBLIC_KEYS = [{ kid: '1', pem: vendor.publicKey.export({ type: 'spki', format: 'pem' }) }];
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `${p}-`));

function memStore() {
  let data = null;
  return {
    async read() {
      return data ? JSON.parse(JSON.stringify(data)) : null;
    },
    async write(obj) {
      data = JSON.parse(JSON.stringify(obj));
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

function makeClock(start) {
  const c = { sys: start, mono: 0 };
  c.tick = (ms) => {
    c.sys += ms;
    c.mono += ms;
  };
  return c;
}

function boot(clk, { stores, files, orderMs = { v: null }, publicKeys = PUBLIC_KEYS, hw = HW } = {}) {
  const clockStores = stores || [memStore(), memStore(), memStore()];
  const licenseFiles = files || createLicenseFiles({ userDataDir: tmp('rt-ud'), secondaryDir: tmp('rt-2nd') });
  const mgr = createLicenseManager({
    getHardwareId: async () => ({ id: hw, source: 'machine-guid' }),
    publicKeys,
    minEpoch: 1,
    licenseFiles,
    clockStores,
    getLatestOrderMs: () => orderMs.v,
    now: () => clk.sys,
    mono: () => clk.mono,
  });
  return { mgr, clockStores, licenseFiles, orderMs };
}

const mint = (over = {}) => issueLicense({ privateKey: vendor.privateKey, kid: '1', hardwareId: HW, customer: 'Cheater Cafe', plan: 'Y01', ...over });

const results = [];
function report(verdict, title, detail) {
  results.push({ verdict, title });
  const tag = verdict === 'BLOCKED' ? '[BLOCKED] ' : verdict === 'LOOPHOLE' ? '[LOOPHOLE]' : '[LIMIT]   ';
  console.log(`${tag} ${title}\n           ${detail}\n`);
}

/** days of license a cheater gets back, measured against an honest customer. */
const days = (ms) => (ms / DAY).toFixed(1);

(async () => {
  console.log('LICENSE CLOCK RED TEAM\n======================\n');

  // 1 ---------------------------------------------------------------
  {
    const clk = makeClock(T0);
    const { mgr } = boot(clk);
    await mgr.init();
    await mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(20 * DAY);
    const honest = (await mgr.getStatus()).daysLeft;
    clk.sys -= 18 * DAY; // roll the clock back 18 days
    clk.tick(1 * HOUR);
    const after = (await mgr.getStatus()).daysLeft;
    report(after > honest ? 'LOOPHOLE' : 'BLOCKED', 'Roll the PC clock back while the POS is running', `days left: honest ${honest}, after an 18-day rollback ${after} (a rollback gains nothing).`);
  }

  // 2 ---------------------------------------------------------------
  {
    const clk = makeClock(T0);
    const { mgr } = boot(clk);
    await mgr.init();
    await mgr.activate(mint({ plan: 'Y01', now: new Date(T0) }).key);
    clk.tick(3 * DAY);
    const d0 = (await mgr.getStatus()).daysLeft;
    clk.sys = Date.UTC(2035, 5, 1);
    clk.tick(HOUR);
    const s = await mgr.getStatus();
    report(!s.locked ? 'BLOCKED' : 'LOOPHOLE', 'Clock jumps 9 years forward while running (accident or sabotage)', `still ${s.state}; license shortened by ${d0 - s.daysLeft} day(s) (bounded: a week per event).`);
  }

  // 3 ---------------------------------------------------------------
  {
    // Every night: close the POS, put the PC clock back to the time it was closed, reopen.
    const clk = makeClock(T0);
    let ctx = boot(clk);
    await ctx.mgr.init();
    await ctx.mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    let realDays = 0;
    for (let day = 0; day < 80; day++) {
      clk.tick(12 * HOUR); // 12 hours of service
      await ctx.mgr.getStatus();
      await ctx.mgr.flush();
      realDays += 0.5;
      // closed for 12 real hours. The cheater puts the clock back so the PC "did not notice".
      realDays += 0.5;
      ctx = boot(clk, { stores: ctx.clockStores, files: ctx.licenseFiles });
      await ctx.mgr.init();
      if (ctx.mgr.isLocked()) break;
    }
    const gain = realDays - 30;
    report(realDays > 31 ? 'LOOPHOLE' : 'BLOCKED', 'Close the POS every night and set the PC clock back to the closing time before opening it', `a 30-day trial lasted ${realDays.toFixed(0)} real days (open 12h/day => about ${(realDays / 30).toFixed(1)}x). The PC date also falls ${(realDays - 30).toFixed(0)} days behind, so receipts and reports show wrong dates.`);
  }

  // 4 ---------------------------------------------------------------
  {
    // Edit the stored calendar in EVERY copy to an older date (PC clock stays honest).
    const clk = makeClock(T0);
    const orderMs = { v: null };
    const a = boot(clk, { orderMs });
    await a.mgr.init();
    await a.mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(40 * DAY);
    orderMs.v = clk.sys; // the restaurant has been taking orders all along
    assert(await a.mgr.getStatus(), 'expired');
    await a.mgr.flush();
    a.clockStores.forEach((st) => st.poke({ ...st.peek(), T: T0 + 1 * DAY, S: T0 + 1 * DAY })); // every copy edited
    const b = boot(clk, { stores: a.clockStores, files: a.licenseFiles, orderMs });
    const s = await b.mgr.init();
    report(s.state === 'expired' ? 'BLOCKED' : 'LOOPHOLE', 'Edit the saved calendar (all 3 copies) back to day 1, PC clock honest, orders exist', `after the edit the license is "${s.state}" (${s.daysLeft} days left).`);
  }

  // 5 ---------------------------------------------------------------
  {
    // Same, but the cheater sets T and S to 0 to fall back on the license issue date.
    const clk = makeClock(T0);
    const orderMs = { v: null };
    const a = boot(clk, { orderMs });
    await a.mgr.init();
    await a.mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(40 * DAY);
    orderMs.v = clk.sys;
    await a.mgr.flush();
    a.clockStores.forEach((st) => st.poke({ T: 0, S: 0, lastRepair: 0 }));
    const b = boot(clk, { stores: a.clockStores, files: a.licenseFiles, orderMs });
    const s = await b.mgr.init();
    report(s.state === 'expired' ? 'BLOCKED' : 'LOOPHOLE', 'Zero the saved calendar in every copy (the license issue date then becomes "now")', `license is "${s.state}", ${s.daysLeft} days left.`);
  }

  // 6 ---------------------------------------------------------------
  {
    // Same edit, but this restaurant has NO orders at all (a trial that was never really used).
    const clk = makeClock(T0);
    const a = boot(clk);
    await a.mgr.init();
    await a.mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(40 * DAY);
    await a.mgr.flush();
    a.clockStores.forEach((st) => st.poke({ ...st.peek(), T: T0 + 1 * DAY, S: T0 + 1 * DAY }));
    const b = boot(clk, { stores: a.clockStores, files: a.licenseFiles });
    const s = await b.mgr.init();
    report(s.state === 'expired' ? 'BLOCKED' : 'LOOPHOLE', 'Edit the saved calendar back when there is nothing in the database to prove the date (no orders, no backups)', `license is "${s.state}", ${s.daysLeft} days left.`);
  }

  // 7 ---------------------------------------------------------------
  {
    const clk = makeClock(T0);
    const orderMs = { v: null };
    const a = boot(clk, { orderMs });
    await a.mgr.init();
    await a.mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(40 * DAY);
    orderMs.v = clk.sys;
    await a.mgr.flush();
    a.clockStores.forEach((st) => st.wipe());
    const b = boot(clk, { stores: a.clockStores, files: a.licenseFiles, orderMs });
    const s = await b.mgr.init();
    report(s.state === 'expired' ? 'BLOCKED' : 'LOOPHOLE', 'Delete every saved calendar copy (PC clock honest)', `license is "${s.state}".`);
  }

  // 8 ---------------------------------------------------------------
  for (const back of [8, 20, 90]) {
    const clk = makeClock(T0);
    const orderMs = { v: null };
    const a = boot(clk, { orderMs });
    await a.mgr.init();
    await a.mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(40 * DAY);
    orderMs.v = clk.sys;
    await a.mgr.flush();
    a.clockStores.forEach((st) => st.wipe());
    clk.sys -= back * DAY; // and put the PC clock back too
    const b = boot(clk, { stores: a.clockStores, files: a.licenseFiles, orderMs });
    const s = await b.mgr.init();
    report(
      s.state === 'expired' ? 'BLOCKED' : 'LOOPHOLE',
      `Delete every calendar copy AND put the PC clock back ${back} days (orders in the database are newer than the clock)`,
      `license is "${s.state}", ${s.daysLeft} days left.${back > 10 ? ' The newest order is more than 10 days ahead of the PC clock, so it is treated as a wrong-clock order and not believed (needs the PC date rolled back too, which ruins receipts and reports).' : ''}`
    );
  }

  // 9 ---------------------------------------------------------------
  {
    // Whole-PC snapshot / VM revert: the saved calendar, the database and the license all go back together.
    const clk = makeClock(T0);
    const a = boot(clk);
    await a.mgr.init();
    await a.mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    await a.mgr.flush();
    const snapshot = a.clockStores.map((st) => JSON.parse(JSON.stringify(st.peek())));
    clk.tick(40 * DAY);
    assert(await a.mgr.getStatus(), 'expired');
    await a.mgr.flush();
    a.clockStores.forEach((st, i) => st.poke(snapshot[i])); // revert the disk to the snapshot
    const b = boot(clk, { stores: a.clockStores, files: a.licenseFiles });
    const s = await b.mgr.init();
    report(s.state === 'expired' ? 'BLOCKED' : 'LIMIT', 'Revert the whole PC (VM snapshot / disk image) to a day-1 state', `license is "${s.state}", ${s.daysLeft} days left - but every order since the snapshot is lost too, so this only works for a PC nobody really uses.`);
  }

  // 10 --------------------------------------------------------------
  {
    const clk = makeClock(T0);
    const key = mint({ plan: 'Y01', now: new Date(T0) }).key;
    const pc1 = boot(clk);
    await pc1.mgr.init();
    await pc1.mgr.activate(key);
    const pc2 = boot(clk); // a second, different PC...
    await pc2.mgr.init();
    const s = await pc2.mgr.activate(key).catch((e) => ({ state: `refused: ${e.message.slice(0, 40)}` }));
    // ...that has copied the first PC's Windows MachineGuid (needs administrator rights)
    report(s.state === 'active' ? 'LIMIT' : 'BLOCKED', 'Use the same key on a second PC whose Windows MachineGuid was changed to match', `second PC state: ${s.state}. Offline licensing cannot tell two PCs with the same ID apart.`);
  }

  // 11 --------------------------------------------------------------
  {
    // Vendor first issues a long key, later "corrects" it with a shorter one. Customer wipes the license files and re-enters the long key.
    const clk = makeClock(T0);
    const a = boot(clk);
    await a.mgr.init();
    const long = mint({ plan: 'Y10', now: new Date(T0) }).key;
    const shorter = mint({ plan: 'M30', now: new Date(T0 + 1 * DAY) }).key;
    await a.mgr.activate(long);
    await a.mgr.activate(shorter);
    fs.rmSync(a.licenseFiles.primary, { force: true });
    fs.rmSync(a.licenseFiles.secondary, { force: true });
    const b = boot(clk, { stores: a.clockStores });
    await b.mgr.init();
    const s = await b.mgr.activate(long).catch((e) => ({ state: `refused: ${e.message}` }));
    report(s.state === 'active' ? 'LIMIT' : 'BLOCKED', 'Vendor "revokes" a key by issuing a shorter one; customer deletes the license files and re-enters the old long key', `state: ${s.state}${s.daysLeft ? `, ${s.daysLeft} days left` : ''}. There is no offline revocation - only short terms limit the damage.`);
  }

  // 12 --------------------------------------------------------------
  {
    // A repair code can be re-used after the "already used" memory is wiped, within its 2-day window.
    const clk = makeClock(T0);
    const a = boot(clk);
    await a.mgr.init();
    await a.mgr.activate(mint({ plan: 'M30', now: new Date(T0) }).key);
    clk.tick(2 * DAY);
    const repair = issueRepair({ privateKey: vendor.privateKey, hardwareId: HW, now: new Date(clk.sys) }).key;
    await a.mgr.activate(repair);
    clk.tick(1 * DAY);
    const before = (await a.mgr.getStatus()).daysLeft;
    a.clockStores.forEach((st) => st.wipe());
    const b = boot(clk, { stores: a.clockStores, files: a.licenseFiles });
    await b.mgr.init();
    const s = await b.mgr.activate(repair).catch((e) => ({ daysLeft: before, err: e.message }));
    const gained = s.daysLeft - before;
    report(gained > 0 ? 'LIMIT' : 'BLOCKED', 'Re-use a repair code after wiping the "already used" memory', `gains ${gained} day(s) at most: a repair code only works within 2 days of the day it was made.`);
  }

  // 13 --------------------------------------------------------------
  {
    // Corrupt / hostile values in the saved calendar must not crash the POS or lock an honest customer.
    const cases = { 'text instead of a number': { T: 'abc', S: 'x' }, 'negative': { T: -5, S: -5 }, 'astronomical (disk corruption)': { T: 1e18, S: 1e18 }, 'NaN': { T: NaN, S: NaN } };
    for (const [name, rec] of Object.entries(cases)) {
      const clk = makeClock(T0);
      const a = boot(clk);
      await a.mgr.init();
      await a.mgr.activate(mint({ plan: 'Y01', now: new Date(T0) }).key);
      await a.mgr.flush();
      a.clockStores.forEach((st) => st.poke(rec));
      let s;
      try {
        s = await boot(clk, { stores: a.clockStores, files: a.licenseFiles }).mgr.init();
      } catch (e) {
        report('LOOPHOLE', `Saved calendar contains: ${name}`, `the POS threw: ${e.message}`);
        continue;
      }
      report(s.state === 'active' ? 'BLOCKED' : 'LOOPHOLE', `Saved calendar contains: ${name}`, `license is "${s.state}" (${s.daysLeft} days left).`);
    }
  }

  // 14 --------------------------------------------------------------
  {
    // The per-request lock check, before the license manager has finished starting.
    const clk = makeClock(T0);
    const { mgr } = boot(clk);
    report(mgr.isLocked() ? 'BLOCKED' : 'LOOPHOLE', 'Ask the POS to do something before the license check has finished starting', `isLocked() = ${mgr.isLocked()} (must be true until init() completes).`);
  }

  // 15 --------------------------------------------------------------
  {
    // Every IPC handler must go through safeHandle (which holds the license gate).
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const raw = [...main.matchAll(/ipcMain\.(handle|on|once)\(/g)].length;
    const viaSafe = [...main.matchAll(/safeHandle\(/g)].length;
    const rawOutsideSafe = (main.match(/ipcMain\.(handle|on|once)\(/g) || []).length - 1; // the one inside safeHandle itself
    report(rawOutsideSafe === 0 ? 'BLOCKED' : 'LOOPHOLE', 'A back door: IPC handlers that skip the license gate', `${viaSafe} handlers use safeHandle; ${Math.max(0, rawOutsideSafe)} register ipcMain directly (outside safeHandle).`);
  }

  const loopholes = results.filter((r) => r.verdict === 'LOOPHOLE').length;
  const limits = results.filter((r) => r.verdict === 'LIMIT').length;
  console.log(`Summary: ${results.filter((r) => r.verdict === 'BLOCKED').length} blocked, ${loopholes} loophole(s), ${limits} inherent limit(s) of offline licensing.`);

  function assert(status, expected) {
    if (status.state !== expected) throw new Error(`setup went wrong: expected ${expected}, got ${status.state}`);
  }
})().catch((err) => {
  console.error('RED TEAM SCRIPT FAILED:', err);
  process.exit(1);
});
