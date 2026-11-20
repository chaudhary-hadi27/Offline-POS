#!/usr/bin/env node
'use strict';

/**
 * QA: a running WhatsApp campaign must stop by itself when the licence locks, keep its place,
 * and carry on exactly where it stopped (no duplicates, no skipped customers) after renewal.
 *   node qa/whatsapp-license-qa.js
 * whatsapp-web.js / puppeteer are mocked; the real whatsappService + campaignStore code runs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const ok = (name, cond, note = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${note}`}`);
  if (!cond) failed++;
};

function loadService(userDataDir) {
  const file = path.join(ROOT, 'electron/whatsapp/whatsappService.js');
  const realStore = require(path.join(ROOT, 'electron/whatsapp/campaignStore.js'));
  const mocks = {
    'whatsapp-web.js': { Client: class {}, LocalAuth: class {}, MessageMedia: { fromFilePath: () => ({}) } },
    puppeteer: { executablePath: () => '' },
    qrcode: {},
    dns: { lookup: (h, cb) => cb(null) },
    './campaignStore': realStore,
    './timing': require(path.join(ROOT, 'electron/whatsapp/timing.js')),
  };
  const req = (id) => (id in mocks ? mocks[id] : require(id));
  const src = fs.readFileSync(file, 'utf8') + '\nmodule.exports.__t = { setClient(c) { client = c; clientStatus = "READY"; } };\n';
  const fastTimeout = (fn) => global.setTimeout(fn, 0);
  const m = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', '__dirname', src)(req, m, m.exports, fastTimeout, path.dirname(file));
  realStore.init(userDataDir);
  return { svc: m.exports, store: realStore };
}

const contacts = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `C${i + 1}`, phone: `0300${String(1000000 + i)}` }));
const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for campaign');
    await new Promise((r) => setImmediate(r));
  }
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wa-'));
  const { svc, store } = loadService(dir);
  const sent = [];
  svc.__t.setClient({ getState: async () => 'CONNECTED', sendMessage: async (chat) => { sent.push(chat); }, destroy: async () => {} });

  let locked = false;
  svc.setLicenseGuard(() => locked);
  const origSend = sent.push.bind(sent);
  sent.push = (x) => {
    const r = origSend(x);
    if (sent.length === 20) locked = true; // the licence expires while the 2nd group is being sent
    return r;
  };

  await svc.startCampaign({ contacts: contacts(40), message: 'Deal for {name}' });
  await waitFor(() => !(store.getState() && store.getState().runState === 'running'));
  await new Promise((r) => setTimeout(r, 50));
  let st = store.getState();
  ok('campaign stops when the licence locks mid-campaign', st.runState === 'stopped', `runState=${st.runState}`);
  ok('no message goes out after the lock (sent exactly 20, not 40)', sent.length === 20, `sent=${sent.length}`);
  ok('the loop is released (campaign not shown as active)', (await svc.getStatus()).campaignActive === false);

  locked = false; // licence renewed
  await svc.resumeCampaign();
  await waitFor(() => store.getState().runState === 'completed');
  ok('after renewal the campaign resumes and completes', store.getState().runState === 'completed');
  ok('every customer got exactly one message (no duplicates, none skipped)', sent.length === 40 && new Set(sent).size === 40, `sent=${sent.length} unique=${new Set(sent).size}`);

  // lock arrives while waiting between groups
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wa2-'));
  const b = loadService(dir2);
  const sent2 = [];
  b.svc.__t.setClient({ getState: async () => 'CONNECTED', sendMessage: async (c) => { sent2.push(c); }, destroy: async () => {} });
  let lock2 = false;
  b.svc.setLicenseGuard(() => lock2);
  b.svc.setEventSink((e) => { if (e.type === 'group-wait') lock2 = true; });
  await b.svc.startCampaign({ contacts: contacts(30), message: 'x' });
  await waitFor(() => b.store.getState().runState !== 'running');
  ok('lock during the 6-15 minute wait between groups also stops it (15 sent, group 2 untouched)', sent2.length === 15 && b.store.getState().runState === 'stopped', `sent=${sent2.length} state=${b.store.getState().runState}`);

  // a guard that throws must not kill a healthy campaign
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wa3-'));
  const c = loadService(dir3);
  const sent3 = [];
  c.svc.__t.setClient({ getState: async () => 'CONNECTED', sendMessage: async (x) => { sent3.push(x); }, destroy: async () => {} });
  c.svc.setLicenseGuard(() => { throw new Error('boom'); });
  await c.svc.startCampaign({ contacts: contacts(5), message: 'x' });
  await waitFor(() => c.store.getState().runState === 'completed');
  ok('a crashing guard never silently stops a campaign', sent3.length === 5);

  // no guard set (old behaviour) still works
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wa4-'));
  const d = loadService(dir4);
  const sent4 = [];
  d.svc.__t.setClient({ getState: async () => 'CONNECTED', sendMessage: async (x) => { sent4.push(x); }, destroy: async () => {} });
  await d.svc.startCampaign({ contacts: contacts(5), message: 'x' });
  await waitFor(() => d.store.getState().runState === 'completed');
  ok('without a guard the campaign runs as before', sent4.length === 5);

  // ---- app closed / power cut in the middle of sending
  {
    const fsx = require('fs');
    const slow = (dir, sent, hook) => {
      const file = path.join(ROOT, 'electron/whatsapp/whatsappService.js');
      delete require.cache[require.resolve(path.join(ROOT, 'electron/whatsapp/campaignStore.js'))];
      const store = require(path.join(ROOT, 'electron/whatsapp/campaignStore.js'));
      const mocks = {
        'whatsapp-web.js': { Client: class {}, LocalAuth: class {}, MessageMedia: { fromFilePath: () => ({}) } },
        puppeteer: { executablePath: () => '' },
        qrcode: {},
        dns: { lookup: (h, cb) => cb(null) },
        './campaignStore': store,
        './timing': require(path.join(ROOT, 'electron/whatsapp/timing.js')),
      };
      const req = (id) => (id in mocks ? mocks[id] : require(id));
      const src = fsx.readFileSync(file, 'utf8') + '\nmodule.exports.__t = { setClient(c) { client = c; clientStatus = "READY"; } };\n';
      const m = { exports: {} };
      // contacts are ~0.2 s apart here (the real gap is 8-25 s), so the 150 ms disk write always lands between two contacts
      new Function('require', 'module', 'exports', 'setTimeout', '__dirname', src)(req, m, m.exports, (fn, ms) => global.setTimeout(fn, ms === 2000 ? 0 : 200), path.dirname(file));
      store.init(dir);
      m.exports.__t.setClient({ getState: async () => 'CONNECTED', sendMessage: async (chat) => { sent.push(chat); hook && hook(sent.length, dir); }, destroy: async () => {} });
      return { svc: m.exports, store };
    };
    const longWait = (fn) => waitFor(fn, 60000);
    const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'qa-crash-'));
    const sent = [];
    let snapshot = null;
    const A = slow(dir, sent, (n, d) => { if (n === 25 && !snapshot) snapshot = fsx.readFileSync(path.join(d, 'whatsapp-campaign.json'), 'utf8'); });
    await A.svc.startCampaign({ contacts: contacts(40), message: 'x' });
    await longWait(() => A.store.getState().runState === 'completed');
    const before = sent.slice(0, 25); // what really went out before the "power cut"
    fsx.writeFileSync(path.join(dir, 'whatsapp-campaign.json'), snapshot);

    const B = slow(dir, before);
    const st = B.store.getState();
    const unsure = st.groups.flat().filter((c) => c.status === 'uncertain');
    ok('after a power cut the campaign comes back as "paused", not running', st.runState === 'stopped');
    ok('the customer being sent to at that moment is marked "not sure" (exactly one)', unsure.length === 1 && /may or may not/.test(unsure[0].error), JSON.stringify(unsure));
    await B.svc.resumeCampaign();
    await longWait(() => B.store.getState().runState === 'completed');
    const counts = {};
    before.forEach((c) => { counts[c] = (counts[c] || 0) + 1; });
    ok('resume never sends to the unsure customer on its own: nobody gets a duplicate', Object.values(counts).every((v) => v === 1), JSON.stringify(Object.entries(counts).filter(([, v]) => v > 1)));
    ok('every other customer still gets the message: 40 customers, 40 messages in total, 1 still marked unsure', before.length === 40 && new Set(before).size === 40 && B.store.getUncertainContacts().length === 1, `sends=${before.length} unique=${new Set(before).size}`);

    let err = null;
    try { B.svc.resolveUncertain('whatever'); } catch (e) { err = e.message; }
    ok('an unknown answer changes nothing', B.svc.resolveUncertain('whatever').count === 0 && B.store.getUncertainContacts().length === 1 && !err);
    const n = B.svc.resolveUncertain('skip').count;
    const after = B.store.getState().groups.flat().filter((c) => c.status === 'failed');
    ok('"Skip": the customer moves to Failed with a clear note, and can be retried later', n === 1 && after.length === 1 && /not sure/.test(after[0].error) && B.store.getUncertainContacts().length === 0);
    await B.svc.retryFailedCampaign();
    await longWait(() => B.store.getState().runState === 'completed');
    ok('"Retry failed" sends that one customer again, but only because the owner asked (41 messages, one customer twice)', before.length === 41 && new Set(before).size === 40);

    // "Send again" path from a second power cut
    const dir2 = fsx.mkdtempSync(path.join(os.tmpdir(), 'qa-crash2-'));
    const sent2 = [];
    let snap2 = null;
    const C = slow(dir2, sent2, (k, d) => { if (k === 12 && !snap2) snap2 = fsx.readFileSync(path.join(d, 'whatsapp-campaign.json'), 'utf8'); });
    await C.svc.startCampaign({ contacts: contacts(30), message: 'x' });
    await longWait(() => C.store.getState().runState === 'completed');
    const before2 = sent2.slice(0, 12);
    fsx.writeFileSync(path.join(dir2, 'whatsapp-campaign.json'), snap2);
    const D = slow(dir2, before2);
    ok('second power cut: again exactly one unsure customer, queue paused', D.store.getUncertainContacts().length === 1 && D.store.getState().runState === 'stopped');
    const r = D.svc.resolveUncertain('resend').count;
    await D.svc.resumeCampaign();
    await longWait(() => D.store.getState().runState === 'completed');
    const c2 = {};
    before2.forEach((c) => { c2[c] = (c2[c] || 0) + 1; });
    ok('"Send again": that customer is sent once more (the owner chose it), everyone else exactly once', r === 1 && before2.length === 31 && new Set(before2).size === 30 && Object.values(c2).filter((v) => v > 1).length === 1, `sends=${before2.length}`);
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall WhatsApp licence checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});
