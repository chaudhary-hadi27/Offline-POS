#!/usr/bin/env node
'use strict';

/**
 * Your customer list, from the record file the issue tool keeps (license-keys/issued-licenses.csv).
 *
 *   npm run license:list                   everyone, soonest expiry first
 *   npm run license:list -- --expiring 30  only licenses ending within 30 days (or already ended)
 *   npm run license:list -- --customer cafe  search by name / Hardware ID
 *
 * "Ends" is the date written in the key. If a customer paused a license, the real end is later
 * by the days it was paused, so a paused one may look as if it ends sooner than it does.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./prompt');
const { LEGACY_TIER, TIER_LABELS } = require('../../electron/license/tiers');

const DAY = 86400000;

function parseCsv(text) {
  const rows = [];
  for (const line of String(text || '').split('\n').slice(1)) {
    const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
    if (cells.length >= 8) rows.push(cells);
  }
  return rows;
}

/** One row per PC and tier: the newest license issued for it. */
function summarize(csvText, now = new Date()) {
  const latest = new Map();
  for (const c of parseCsv(csvText)) {
    const [issuedAt, type, customer, hw, plan, expires, , , tier = '', exclusive = ''] = c;
    if (type !== 'license' || !expires) continue;
    const t = tier || LEGACY_TIER;
    const key = `${hw}|${t}`;
    const prev = latest.get(key);
    if (!prev || issuedAt >= prev.issuedAt) latest.set(key, { issuedAt, customer, hw, plan, expires, tier: t, legacy: !tier, exclusive: exclusive === 'yes' });
  }
  const rows = [...latest.values()].map((r) => {
    const end = Date.parse(`${r.expires}T23:59:59Z`);
    const daysLeft = Math.ceil((end - now.getTime()) / DAY);
    return { ...r, daysLeft, status: daysLeft < 0 ? 'ENDED' : daysLeft <= 7 ? 'ends this week' : daysLeft <= 30 ? 'ends this month' : 'active' };
  });
  return rows.sort((a, b) => a.daysLeft - b.daysLeft);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir || path.join(__dirname, '..', '..', 'license-keys'));
  const file = path.join(dir, 'issued-licenses.csv');
  if (!fs.existsSync(file)) {
    console.error(`No record file yet (${file}). It is created when you issue the first key.`);
    process.exit(1);
  }
  let rows = summarize(fs.readFileSync(file, 'utf8'));
  if (args.expiring && args.expiring !== true) rows = rows.filter((r) => r.daysLeft <= Number(args.expiring));
  if (args.customer && args.customer !== true) {
    const q = String(args.customer).toLowerCase();
    rows = rows.filter((r) => r.customer.toLowerCase().includes(q) || r.hw.toLowerCase().includes(q));
  }
  if (rows.length === 0) {
    console.log('Nothing to show.');
    process.exit(0);
  }
  const pad = (v, n) => String(v).padEnd(n);
  console.log(`${pad('Customer', 26)}${pad('Hardware ID', 21)}${pad('Tier', 9)}${pad('Plan', 7)}${pad('Ends', 12)}${pad('Days', 6)}Status`);
  for (const r of rows) {
    console.log(`${pad(r.customer.slice(0, 24), 26)}${pad(r.hw, 21)}${pad(TIER_LABELS[r.tier] + (r.legacy ? '*' : ''), 9)}${pad(r.plan, 7)}${pad(r.expires, 12)}${pad(r.daysLeft, 6)}${r.status}`);
  }
  if (rows.some((r) => r.legacy)) console.log('\n* old key from before tiers: it runs as Premium. Issue a tiered key when they renew.');
}

module.exports = { summarize, parseCsv };
