#!/usr/bin/env node
'use strict';

/**
 * Create a license key (or a clock-repair code) for one customer PC.
 *
 *   node tools/license/issue-license.js
 *       asks for everything step by step (easiest)
 *
 *   node tools/license/issue-license.js --machine A1B2-C3D4-E5F6-7890 --customer "A1 Bite" --plan Y01 --tier premium
 *   node tools/license/issue-license.js ... --plan CUSTOM --expires 2027-03-31
 *   node tools/license/issue-license.js ... --plan Y01 --extend-from 2027-01-15   (renewal: keeps unused days)
 *   node tools/license/issue-license.js --repair --machine A1B2-C3D4-E5F6-7890    (clock-repair code)
 *
 * Plans: M30 (30 days), Y01 (1 year), Y03 (3 years), Y10 (10 years), CUSTOM.
 * Options: --key <path to private-N.pem>   --kid <N>   --epoch <n> (default: the app's current minimum)   --dir <license-keys folder>   --skip-date-check
 * Passphrase: typed when asked, or the LICENSE_PASSPHRASE environment variable.
 */

const fs = require('fs');
const path = require('path');
const { ask, parseArgs } = require('./prompt');
const { PLANS, issueLicense, issueRepair, loadPrivateKey, parseYmd, ymd, readLastExpiry, readLastTier, checkVendorClock, TIER_LABELS } = require('./licenseTool');
const { getOnlineTimeMs } = require('./onlineTime');
const { ISSUABLE_TIERS } = require('../../electron/license/tiers');
const { MIN_LICENSE_EPOCH } = require('../../electron/license/publicKeys');

const ROOT = path.join(__dirname, '..', '..');

function csvCell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  node tools/license/issue-license.js                      (asks step by step)
  node tools/license/issue-license.js --machine <ID> --customer "<name>" --plan M30|Y01|Y03|Y10|CUSTOM --tier pro|premium [--exclusive] [--expires YYYY-MM-DD]
  node tools/license/issue-license.js ... --renew                        renewal: finds the current expiry itself, keeps unused days
  node tools/license/issue-license.js ... --extend-from YYYY-MM-DD       same, but you give the date
  node tools/license/issue-license.js --repair --machine <ID>            clock-repair code
Options: --key <private-N.pem>  --kid <N>  --epoch <n>  --dir <license-keys folder>
Passphrase: asked when needed, or set LICENSE_PASSPHRASE.`);
    return;
  }

  const dir = path.resolve(args.dir || path.join(ROOT, 'license-keys'));
  const kid = String(args.kid || '1');
  const keyPath = path.resolve(args.key || path.join(dir, `private-${kid}.pem`));
  if (!fs.existsSync(keyPath)) {
    console.error(`Private key not found: ${keyPath}\nPlug in the USB drive / pass --key <path>, or run generate-keys.js first.`);
    process.exit(1);
  }

  const isRepair = Boolean(args.repair);
  const machine = args.machine && args.machine !== true ? args.machine : await ask('Customer Hardware ID (A1B2-C3D4-E5F6-7890): ');
  let customer = null;
  let plan = null;
  let tier = null;
  if (!isRepair) {
    customer = args.customer && args.customer !== true ? args.customer : await ask('Restaurant / customer name: ');
    plan = String(args.plan && args.plan !== true ? args.plan : await ask(`Plan (${Object.keys(PLANS).join(' / ')}): `)).toUpperCase();
    // Pro = every page except WhatsApp.  Premium = everything including WhatsApp Deals.
    const lastCsv = path.join(dir, 'issued-licenses.csv');
    const lastTier = fs.existsSync(lastCsv) ? readLastTier(fs.readFileSync(lastCsv, 'utf8'), machine) : null;
    tier = String(args.tier && args.tier !== true ? args.tier : await ask(`Tier (${ISSUABLE_TIERS.join(' / ')})${lastTier ? ` [this PC had: ${lastTier}]` : ''}: `)).trim().toLowerCase();
    if (!ISSUABLE_TIERS.includes(tier)) {
      console.error(`Tier must be ${ISSUABLE_TIERS.join(' or ')}.`);
      process.exit(1);
    }
  }

  let expires = args.expires;
  if (!isRepair && plan === 'CUSTOM' && !expires) expires = await ask('Expiry date (YYYY-MM-DD): ');

  // The issue date inside the key becomes the customer's calendar floor, so never sign with a wrong PC date.
  if (!args['skip-date-check']) {
    const csvPath = path.join(dir, 'issued-licenses.csv');
    const clock = checkVendorClock({
      nowMs: Date.now(),
      onlineNowMs: await getOnlineTimeMs(),
      csvText: fs.existsSync(csvPath) ? fs.readFileSync(csvPath, 'utf8') : '',
    });
    clock.warnings.forEach((w) => console.warn(`Warning: ${w}`));
    if (!clock.ok) {
      clock.problems.forEach((p) => console.error(`Refusing to sign: ${p}`));
      console.error('(Override with --skip-date-check only if you are sure.)');
      process.exit(1);
    }
  }

  const passphrase = process.env.LICENSE_PASSPHRASE || (await ask('Private key passphrase (not shown): ', { hidden: true }));
  const privateKey = loadPrivateKey(fs.readFileSync(keyPath, 'utf8'), passphrase);

  let result;
  if (isRepair) {
    result = issueRepair({ privateKey, kid, hardwareId: machine });
  } else {
    // renewal: start counting from the later of today and the current expiry day
    let from = new Date();
    let extendFrom = args['extend-from'] && args['extend-from'] !== true ? args['extend-from'] : null;
    if (args.renew && !extendFrom) {
      // renewal: find this PC's current license in our own record and keep its unused days
      const csv = path.join(dir, 'issued-licenses.csv');
      extendFrom = fs.existsSync(csv) ? readLastExpiry(fs.readFileSync(csv, 'utf8'), machine, tier) : null;
      console.log(extendFrom ? `Renewal: the current license for this PC ends ${extendFrom}.` : 'Renewal: no earlier license found for this PC in the record - starting from today.');
    }
    if (extendFrom) {
      const current = parseYmd(extendFrom);
      if (current.getTime() > from.getTime()) from = current;
    }
    result = issueLicense({
      privateKey,
      kid,
      hardwareId: machine,
      customer,
      plan,
      tier,
      exclusive: !!args.exclusive,
      from,
      expires,
      epoch: args.epoch ? Number(args.epoch) : MIN_LICENSE_EPOCH,
    });
  }

  const p = result.payload;
  console.log('\n----------------------------------------------------------------');
  if (isRepair) {
    console.log(`REPAIR CODE for PC ${p.mid}  (valid only within 2 days of ${new Date(p.now * 1000).toISOString().slice(0, 10)})`);
  } else {
    console.log(`LICENSE for "${p.cust}"   PC ${p.mid}`);
    console.log(`Tier ${TIER_LABELS[p.tier]}${p.excl ? ' (EXCLUSIVE: removes the customer\'s other licenses)' : ''}   Plan ${p.plan} (${PLANS[p.plan].label})   issued ${ymd(new Date(p.iat * 1000))}   EXPIRES ${ymd(new Date(p.exp * 1000))}`);
  }
  console.log('----------------------------------------------------------------\n');
  console.log(result.key);
  console.log('\n(Send the whole text above. It is one long line - WhatsApp wrapping is fine, the app ignores line breaks.)\n');

  // keep a record of everything issued (vendor-side only)
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'issued-licenses.csv');
  const CSV_HEADER = 'issued_at,type,customer,hardware_id,plan,expires,kid,key,tier,exclusive';
  if (!fs.existsSync(log)) fs.writeFileSync(log, `${CSV_HEADER}\n`);
  else {
    // older record files had no tier column: add it to the header (old rows simply have no tier)
    const old = fs.readFileSync(log, 'utf8');
    const firstLine = old.split('\n')[0];
    if (!/,exclusive\s*$/.test(firstLine)) fs.writeFileSync(log, old.replace(firstLine, CSV_HEADER));
  }
  fs.appendFileSync(
    log,
    [
      new Date().toISOString(),
      isRepair ? 'repair' : 'license',
      p.cust || '',
      p.mid,
      p.plan || '',
      p.exp ? ymd(new Date(p.exp * 1000)) : '',
      p.kid,
      result.key,
      p.tier || '',
      p.excl ? 'yes' : '',
    ]
      .map(csvCell)
      .join(',') + '\n'
  );
  console.log(`Recorded in ${log}`);
})().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
