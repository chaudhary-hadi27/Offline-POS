#!/usr/bin/env node
'use strict';

/**
 * Create a license key (or a clock-repair code) for one customer PC.
 *
 *   node tools/license/issue-license.js
 *       asks for everything step by step (easiest)
 *
 *   node tools/license/issue-license.js --machine A1B2-C3D4-E5F6-7890 --customer "A1 Bite" --plan Y01
 *   node tools/license/issue-license.js ... --plan CUSTOM --expires 2027-03-31
 *   node tools/license/issue-license.js ... --plan Y01 --extend-from 2027-01-15   (renewal: keeps unused days)
 *   node tools/license/issue-license.js --repair --machine A1B2-C3D4-E5F6-7890    (clock-repair code)
 *
 * Plans: M30 (30 days), Y01 (1 year), Y03 (3 years), Y10 (10 years), CUSTOM.
 * Options: --key <path to private-N.pem>   --kid <N>   --epoch <n>   --dir <license-keys folder>
 * Passphrase: typed when asked, or the LICENSE_PASSPHRASE environment variable.
 */

const fs = require('fs');
const path = require('path');
const { ask, parseArgs } = require('./prompt');
const { PLANS, issueLicense, issueRepair, loadPrivateKey, parseYmd, ymd, readLastExpiry } = require('./licenseTool');

const ROOT = path.join(__dirname, '..', '..');

function csvCell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  node tools/license/issue-license.js                      (asks step by step)
  node tools/license/issue-license.js --machine <ID> --customer "<name>" --plan M30|Y01|Y03|Y10|CUSTOM [--expires YYYY-MM-DD]
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
  if (!isRepair) {
    customer = args.customer && args.customer !== true ? args.customer : await ask('Restaurant / customer name: ');
    plan = String(args.plan && args.plan !== true ? args.plan : await ask(`Plan (${Object.keys(PLANS).join(' / ')}): `)).toUpperCase();
  }

  let expires = args.expires;
  if (!isRepair && plan === 'CUSTOM' && !expires) expires = await ask('Expiry date (YYYY-MM-DD): ');

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
      extendFrom = fs.existsSync(csv) ? readLastExpiry(fs.readFileSync(csv, 'utf8'), machine) : null;
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
      from,
      expires,
      epoch: args.epoch ? Number(args.epoch) : 1,
    });
  }

  const p = result.payload;
  console.log('\n----------------------------------------------------------------');
  if (isRepair) {
    console.log(`REPAIR CODE for PC ${p.mid}  (valid only within 2 days of ${new Date(p.now * 1000).toISOString().slice(0, 10)})`);
  } else {
    console.log(`LICENSE for "${p.cust}"   PC ${p.mid}`);
    console.log(`Plan ${p.plan} (${PLANS[p.plan].label})   issued ${ymd(new Date(p.iat * 1000))}   EXPIRES ${ymd(new Date(p.exp * 1000))}`);
  }
  console.log('----------------------------------------------------------------\n');
  console.log(result.key);
  console.log('\n(Send the whole text above. It is one long line - WhatsApp wrapping is fine, the app ignores line breaks.)\n');

  // keep a record of everything issued (vendor-side only)
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'issued-licenses.csv');
  if (!fs.existsSync(log)) fs.writeFileSync(log, 'issued_at,type,customer,hardware_id,plan,expires,kid,key\n');
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
    ]
      .map(csvCell)
      .join(',') + '\n'
  );
  console.log(`Recorded in ${log}`);
})().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
