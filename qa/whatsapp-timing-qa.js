#!/usr/bin/env node
'use strict';

/**
 * QA: WhatsApp sending speed (Settings > WhatsApp).
 *   node qa/whatsapp-timing-qa.js
 * Checks the rules (electron/whatsapp/timing.js), that the screen's copy of the numbers matches,
 * and that the real campaign loop actually waits as long as the setting says.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'electron/whatsapp/timing'));
const { SAFE, LIMITS, KEYS: K } = T;

let failed = 0;
const ok = (name, cond, note = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${note}`}`);
  if (!cond) failed++;
};
const throwsMsg = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.message;
  }
};
const on = (o = {}) => ({ [K.custom]: '1', [K.contactMin]: '8', [K.contactMax]: '25', [K.groupMin]: '6', [K.groupMax]: '15', ...o });

(async () => {
  // ---- resolveTiming
  const d = T.resolveTiming({});
  ok('default = recommended safe speed (8-25 s, 6-15 min)', d.contactMinMs === 8000 && d.contactMaxMs === 25000 && d.groupMinMs === 360000 && d.groupMaxMs === 900000 && !d.custom);
  ok('toggle OFF ignores any stored custom numbers', T.resolveTiming({ ...on({ [K.contactMin]: '3' }), [K.custom]: '0' }).contactMinMs === 8000);
  const slower = T.resolveTiming(on({ [K.contactMin]: '20', [K.contactMax]: '40', [K.groupMin]: '10', [K.groupMax]: '30' }));
  ok('slower than safe is used as typed and needs no confirmation', slower.contactMinMs === 20000 && slower.groupMaxMs === 1800000 && !slower.risky && !slower.usingSafeFallback);
  const fastNoAck = T.resolveTiming(on({ [K.contactMin]: '4' }));
  ok('faster than safe WITHOUT the confirmation silently falls back to safe speed', fastNoAck.usingSafeFallback && fastNoAck.contactMinMs === 8000 && fastNoAck.risky);
  const fastAck = T.resolveTiming(on({ [K.contactMin]: '4', [K.ack]: '2026-11-11T00:00:00Z' }));
  ok('faster than safe WITH the confirmation is used', !fastAck.usingSafeFallback && fastAck.contactMinMs === 4000 && fastAck.risky && fastAck.acknowledged);
  ok('group wait faster than safe also needs the confirmation', T.resolveTiming(on({ [K.groupMin]: '2' })).usingSafeFallback && !T.resolveTiming(on({ [K.groupMin]: '2', [K.ack]: 'x' })).usingSafeFallback);

  // tampered / garbage values never escape the hard limits
  let bad = 0;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const junk = () => ['', 'abc', '-5', '0', '2', '3.5', '9999', '1e9', ' 7 ', null, undefined, 12, 500, '120', '121', '60', '61', '1', '٣'][Math.floor(rnd() * 19)];
  for (let i = 0; i < 4000; i++) {
    const s = { [K.custom]: '1', [K.contactMin]: junk(), [K.contactMax]: junk(), [K.groupMin]: junk(), [K.groupMax]: junk(), [K.ack]: rnd() > 0.5 ? 'x' : '' };
    const t = T.resolveTiming(s);
    const inRange = t.contactMinMs >= LIMITS.contact.min * 1000 && t.contactMaxMs <= LIMITS.contact.max * 1000 && t.groupMinMs >= LIMITS.group.min * 60000 && t.groupMaxMs <= LIMITS.group.max * 60000;
    const ordered = t.contactMinMs <= t.contactMaxMs && t.groupMinMs <= t.groupMaxMs;
    const safeUnlessAcked = t.acknowledged || (t.contactMinMs >= 8000 && t.groupMinMs >= 360000);
    if (!(inRange && ordered && safeUnlessAcked)) bad++;
  }
  ok('4000 random/tampered settings: always inside the hard limits, ordered, and never faster than safe without the confirmation', bad === 0, `${bad} bad`);

  // ---- validateTimingEntries (what a Settings save may do)
  ok('save: value below the hard floor (2 s) refused', /from 3 to 120/.test(throwsMsg(() => T.validateTimingEntries(on({ [K.contactMin]: '2' }, {})))));
  ok('save: value above the hard ceiling (61 min) refused', /from 1 to 60/.test(throwsMsg(() => T.validateTimingEntries(on({ [K.groupMax]: '61' }), {}))));
  ok('save: decimals / text / empty refused', ['3.5', 'abc', '', '-4', '1e3'].every((v) => throwsMsg(() => T.validateTimingEntries(on({ [K.contactMax]: v }), {}))));
  ok('save: longest shorter than shortest refused', /cannot be shorter/.test(throwsMsg(() => T.validateTimingEntries(on({ [K.contactMin]: '30', [K.contactMax]: '20' }), {}))));
  ok('save: faster than safe without the tick refused (with a clear message)', /Tick the box/.test(throwsMsg(() => T.validateTimingEntries(on({ [K.contactMin]: '4' }), {}))));
  const stamped = T.validateTimingEntries(on({ [K.contactMin]: '4', [K.ack]: '1' }), {}, '2026-11-11T10:00:00.000Z');
  ok('save: with the tick it is accepted and the APP stamps the time (screen cannot forge it)', stamped[K.ack] === '2026-11-11T10:00:00.000Z');
  const forged = T.validateTimingEntries(on({ [K.contactMin]: '4', [K.ack]: '1' }), {}, 'NOW');
  ok('save: the stored confirmation is the app time, not what the screen sent', forged[K.ack] === 'NOW');
  ok('save: an old confirmation does not cover a new faster setting', !!throwsMsg(() => T.validateTimingEntries({ [K.contactMin]: '3' }, on({ [K.contactMin]: '4', [K.ack]: '2026-01-01' }))));
  ok('save: safe values need no confirmation, and any stored confirmation is cleared', T.validateTimingEntries({ ...on(), [K.ack]: '' }, { [K.ack]: 'old' })[K.ack] === '');
  ok('save: turning the toggle OFF is always allowed', !throwsMsg(() => T.validateTimingEntries({ [K.custom]: '0', [K.ack]: '' }, on({ [K.contactMin]: '3' }))));
  ok('save: the toggle value is normalised to 0/1', T.validateTimingEntries({ [K.custom]: 'yes' }, {})[K.custom] === '0' && T.validateTimingEntries({ [K.custom]: '1' }, {})[K.custom] === '1');
  ok('touchesTimingKeys detects the keys and nothing else', T.touchesTimingKeys({ [K.custom]: '1' }) && !T.touchesTimingKeys({ tax_rate: '5' }) && !T.touchesTimingKeys(null) && !T.touchesTimingKeys([]));

  // ---- slider stops (profiles)
  const P = T.PROFILES;
  ok('7 slider stops, slowest to fastest, stop 2 is the recommended safe speed (= defaults)', P.length === 7 && P[T.DEFAULT_PROFILE_INDEX].contactMin === SAFE.contact.min && P[T.DEFAULT_PROFILE_INDEX].contactMax === SAFE.contact.max && P[T.DEFAULT_PROFILE_INDEX].groupMin === SAFE.group.min && P[T.DEFAULT_PROFILE_INDEX].groupMax === SAFE.group.max);
  ok('every stop is valid: inside the hard limits, shortest <= longest', P.every((x) => x.contactMin >= LIMITS.contact.min && x.contactMax <= LIMITS.contact.max && x.groupMin >= LIMITS.group.min && x.groupMax <= LIMITS.group.max && x.contactMin <= x.contactMax && x.groupMin <= x.groupMax));
  ok('stops get monotonically faster (average wait never grows)', P.every((x, i) => i === 0 || (x.contactMin + x.contactMax <= P[i - 1].contactMin + P[i - 1].contactMax && x.groupMin + x.groupMax <= P[i - 1].groupMin + P[i - 1].groupMax)));
  ok('stops 0-2 need no confirmation, stops 3-6 are all "faster than safe"', P.every((x, i) => T.isRisky(x) === (i > T.DEFAULT_PROFILE_INDEX)), P.map((x) => T.isRisky(x)).join());
  ok('each safe stop saves without a tick; each risky stop is refused without it and accepted with it', P.every((x, i) => {
    const e = on({ [K.contactMin]: String(x.contactMin), [K.contactMax]: String(x.contactMax), [K.groupMin]: String(x.groupMin), [K.groupMax]: String(x.groupMax) });
    const without = throwsMsg(() => T.validateTimingEntries(e, {}));
    const withTick = throwsMsg(() => T.validateTimingEntries({ ...e, [K.ack]: '1' }, {}));
    return withTick === null && (i > T.DEFAULT_PROFILE_INDEX ? !!without : without === null);
  }));
  ok('a saved stop is used exactly by the sender once confirmed', P.every((x) => {
    const r = T.resolveTiming(on({ [K.contactMin]: String(x.contactMin), [K.contactMax]: String(x.contactMax), [K.groupMin]: String(x.groupMin), [K.groupMax]: String(x.groupMax), [K.ack]: 'x' }));
    return r.contactMinMs === x.contactMin * 1000 && r.contactMaxMs === x.contactMax * 1000 && r.groupMinMs === x.groupMin * 60000 && r.groupMaxMs === x.groupMax * 60000;
  }));

  // ---- the screen's copy must match
  const ui = await import(pathToFileURL(path.join(ROOT, 'src/shell/whatsappTiming.js')).href);
  ok('screen constants == rules (SAFE, LIMITS, keys, warning text, all 7 slider stops)', JSON.stringify(ui.PROFILES) === JSON.stringify(T.PROFILES) && ui.DEFAULT_PROFILE_INDEX === T.DEFAULT_PROFILE_INDEX && JSON.stringify(ui.SAFE) === JSON.stringify(SAFE) && JSON.stringify(ui.LIMITS) === JSON.stringify(LIMITS) && JSON.stringify(ui.KEYS) === JSON.stringify(K) && ui.RISK_WARNING === T.RISK_WARNING);
  ok('screen validate()/isRisky() agree with the rules', ui.isRisky({ contactMin: 7, groupMin: 6 }) === T.isRisky({ contactMin: 7, groupMin: 6 }) && ui.isRisky({ contactMin: 8, groupMin: 6 }) === false && !!ui.validate({ contactMin: 2, contactMax: 9, groupMin: 6, groupMax: 9 }) && ui.validate({ contactMin: 8, contactMax: 25, groupMin: 6, groupMax: 15 }) === null);

  // ---- main.js wiring (source-level)
  const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  ok('main.js hands the sender the raw saved settings, read fresh every time (no double-resolving)', /setTimingProvider\(\(\) => settingsRepo\.getAllSettings\(\)\)/.test(main));
  ok('main.js validates timing saves and requires Premium for them', /touchesTimingKeys\(entries\)/.test(main) && /validateTimingEntries\(entries, settingsRepo\.getAllSettings\(\)\)/.test(main) && /hasTier\('premium'\)/.test(main));

  // ---- the real campaign loop honours the setting
  const Module = require('module');
  function loadService(dir, sleeps) {
    const file = path.join(ROOT, 'electron/whatsapp/whatsappService.js');
    const store = require(path.join(ROOT, 'electron/whatsapp/campaignStore.js'));
    const mocks = {
      'whatsapp-web.js': { Client: class {}, LocalAuth: class {}, MessageMedia: { fromFilePath: () => ({}) } },
      puppeteer: { executablePath: () => '' },
      qrcode: {},
      dns: { lookup: (h, cb) => cb(null) },
      './campaignStore': store,
      './timing': T,
    };
    const req = (id) => (id in mocks ? mocks[id] : require(id));
    const src = fs.readFileSync(file, 'utf8') + '\nmodule.exports.__t = { setClient(c) { client = c; clientStatus = "READY"; } };\n';
    const rec = (fn, ms) => {
      sleeps.push({ ms, mode: sleeps.mode || 'contact' });
      return global.setTimeout(fn, 0);
    };
    const m = { exports: {} };
    new Function('require', 'module', 'exports', 'setTimeout', '__dirname', src)(req, m, m.exports, rec, path.dirname(file));
    store.init(dir);
    return { svc: m.exports, store };
  }
  const waitFor = async (fn, ms = 8000) => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > ms) throw new Error('timeout');
      await new Promise((r) => setImmediate(r));
    }
  };
  const contacts = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `C${i + 1}`, phone: `0300${1000000 + i}` }));

  async function run(settings, n = 31) {
    const sleeps = [];
    const { svc, store } = loadService(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wt-')), sleeps);
    svc.__t.setClient({ getState: async () => 'CONNECTED', sendMessage: async () => {}, destroy: async () => {} });
    svc.setTimingProvider(() => settings);
    svc.setEventSink((e) => {
      if (e.type === 'group-wait') sleeps.mode = 'group';
      if (e.type === 'group-start') sleeps.mode = 'contact';
    });
    await svc.startCampaign({ contacts: contacts(n), message: 'x' });
    await waitFor(() => store.getState().runState === 'completed');
    // each pause is tagged by phase: between customers (one sleep each) or between groups (polled in <=2 s slices)
    const contactGaps = sleeps.filter((x) => x.mode === 'contact').map((x) => x.ms);
    const pollSum = sleeps.filter((x) => x.mode === 'group').reduce((a, x) => a + x.ms, 0);
    return { contactGaps, pollSum, sleeps };
  }

  const def = await run({});
  ok('campaign with no custom speed waits 8-25 s between customers', def.contactGaps.length > 20 && def.contactGaps.every((ms) => ms >= 8000 && ms <= 25000), `${Math.min(...def.contactGaps)}..${Math.max(...def.contactGaps)}`);
  const slow = await run(on({ [K.contactMin]: '40', [K.contactMax]: '50', [K.groupMin]: '20', [K.groupMax]: '20' }));
  ok('campaign with a SLOWER custom speed waits 40-50 s between customers', slow.contactGaps.length > 20 && slow.contactGaps.every((ms) => ms >= 40000 && ms <= 50000), `${Math.min(...slow.contactGaps)}..${Math.max(...slow.contactGaps)}`);
  ok('...and the group wait is exactly the chosen 20 minutes', slow.pollSum === 2 * 1200 * 1000, `sum=${slow.pollSum} (31 customers = 3 groups = 2 group waits)`);
  const fastOk = await run(on({ [K.contactMin]: '3', [K.contactMax]: '4', [K.groupMin]: '1', [K.groupMax]: '1', [K.ack]: '2026-11-11' }));
  ok('campaign with a confirmed FAST speed waits 3-4 s between customers', fastOk.contactGaps.length === 0 ? false : fastOk.contactGaps.every((ms) => ms >= 3000 && ms <= 4000), `${Math.min(...fastOk.contactGaps)}..${Math.max(...fastOk.contactGaps)}`);
  const fastBad = await run(on({ [K.contactMin]: '3', [K.contactMax]: '4', [K.groupMin]: '1', [K.groupMax]: '1' }));
  ok('campaign with a fast speed that was NOT confirmed (e.g. edited into the database) still uses 8-25 s', fastBad.contactGaps.every((ms) => ms >= 8000 && ms <= 25000), `${Math.min(...fastBad.contactGaps)}..${Math.max(...fastBad.contactGaps)}`);
  const broken = await (async () => {
    const sleeps = [];
    const { svc, store } = loadService(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wt2-')), sleeps);
    svc.__t.setClient({ getState: async () => 'CONNECTED', sendMessage: async () => {}, destroy: async () => {} });
    svc.setTimingProvider(() => {
      throw new Error('settings unreadable');
    });
    await svc.startCampaign({ contacts: contacts(5), message: 'x' });
    await waitFor(() => store.getState().runState === 'completed');
    const gaps = sleeps.filter((x) => x.mode === 'contact').map((x) => x.ms);
    return gaps.length > 0 && gaps.every((ms) => ms >= 8000 && ms <= 25000);
  })();
  ok('if the settings cannot be read, the sender uses the safe speed (never crashes, never goes fast)', broken);

  console.log(failed ? `\n${failed} FAILED` : '\nall WhatsApp timing checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});
