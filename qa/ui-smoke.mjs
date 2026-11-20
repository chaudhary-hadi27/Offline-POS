// UI smoke test (jsdom): tiers on the dashboard / router / Settings, and the WhatsApp speed form.
//   node --experimental-default-type=module --import ./qa/register-json.mjs qa/ui-smoke.mjs   (needs: npm i --no-save jsdom)
import { JSDOM } from 'jsdom';
import { createRequire } from 'module';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const require = createRequire(import.meta.url);

const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  try {
    globalThis[k] = dom.window[k];
  } catch {
    Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true });
  }
}

let failed = 0;
const ok = (name, cond, note = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${note}`}`);
  if (!cond) failed++;
};
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ---- real license statuses (built by the real manager) for each tier
const { createLicenseManager } = require(path.join(ROOT, 'electron/license/licenseManager'));
const tool = require(path.join(ROOT, 'tools/license/licenseTool'));
const kp = crypto.generateKeyPairSync('ed25519');
const PUB = [{ kid: '1', pem: kp.publicKey.export({ type: 'spki', format: 'pem' }) }];
const HW = 'AAAA-BBBB-CCCC-DDDD';
async function statusFor(tierName) {
  let text = tierName ? tool.issueLicense({ privateKey: kp.privateKey, hardwareId: HW, customer: 'QA Cafe', plan: 'Y01', tier: tierName }).key : null;
  const m = createLicenseManager({ now: () => Date.now(), mono: () => 1e6, getHardwareId: async () => ({ id: HW, source: 'machine-guid' }), publicKeys: PUB, licenseFiles: { load: async () => text, save: async (t) => (text = t) }, clockStores: [], log: () => {} });
  await m.init();
  return m.getStatus();
}
const S = { free: await statusFor(null), pro: await statusFor('pro'), premium: await statusFor('premium') };

// a PC that holds BOTH licenses (Premium running, Pro paused), built by the real manager
async function walletStatus() {
  let text = null;
  const m = createLicenseManager({ now: () => Date.now(), mono: () => 1e6, getHardwareId: async () => ({ id: HW, source: 'machine-guid' }), publicKeys: PUB, licenseFiles: { load: async () => text, save: async (t) => (text = t), clear: async () => (text = null) }, clockStores: [], log: () => {} });
  await m.init();
  await m.activate(tool.issueLicense({ privateKey: kp.privateKey, hardwareId: HW, customer: 'QA Cafe', plan: 'Y01', tier: 'pro' }).key);
  const st = await m.activate(tool.issueLicense({ privateKey: kp.privateKey, hardwareId: HW, customer: 'QA Cafe', plan: 'M30', tier: 'premium' }).key);
  return { m, st };
}

const { posApi } = await import(pathToFileURL(path.join(ROOT, 'src/shell/posApi.js')).href);
const lic = await import(pathToFileURL(path.join(ROOT, 'src/shell/license.js')).href);
const { renderDashboard } = await import(pathToFileURL(path.join(ROOT, 'src/shell/dashboard.js')).href);
const { createRouter } = await import(pathToFileURL(path.join(ROOT, 'src/shell/router.js')).href);
const { renderSettings } = await import(pathToFileURL(path.join(ROOT, 'src/modules/settings.js')).href);
const { shellStore } = await import(pathToFileURL(path.join(ROOT, 'src/shell/state.js')).href);

let current = S.free;
posApi.license.getStatus = async () => current;
const setTier = async (t) => {
  current = S[t];
  await lic.refreshLicense();
};

// ---------- dashboard badges
await setTier('pro');
let el = renderDashboard({ onNavigate() {} });
document.body.appendChild(el);
const card = (id) => el.querySelector(`[data-module-id="${id}"]`);
ok('Pro: WhatsApp card is marked Premium and dimmed', /Premium/.test(card('whatsapp-deals').textContent) && card('whatsapp-deals').classList.contains('opacity-60'));
ok('Pro: other cards are open (no tag)', !/Pro|Premium/.test(card('new-order').textContent) && !card('new-order').classList.contains('opacity-60'));
await setTier('free');
ok('Free: every page except Settings is marked Pro/Premium (updates live)', /Pro/.test(card('customers').textContent) && !/Pro|Premium/.test(card('settings').textContent));
await setTier('premium');
ok('Premium: nothing is marked', !el.querySelector('.tier-pill'));
el._cleanup?.();
el.remove();

// ---------- router gate
const router = createRouter({ onRequestPalette() {}, requireAccess: async () => true, isLocked: lic.isLocked });
document.body.appendChild(router.el);
await setTier('pro');
await router.navigate('whatsapp-deals');
await tick(30);
ok('Pro: opening WhatsApp Deals is refused and the page does not change', shellStore.get().route !== 'whatsapp-deals');
ok('Pro: the refusal explains it needs Premium', /Premium/.test(document.body.textContent) && /needs the Premium license/.test(document.body.textContent));
await router.navigate('customers');
await tick(30);
ok('Pro: Customers opens', shellStore.get().route === 'customers');
await setTier('free');
await router.navigate('analytics');
await tick(30);
ok('Free: Analytics is refused and the user is sent to Settings', shellStore.get().route === 'settings');
await setTier('premium');
await router.navigate('whatsapp-deals');
await tick(30);
ok('Premium: WhatsApp Deals opens', shellStore.get().route === 'whatsapp-deals');
router.el.remove();

// ---------- Settings: License card + WhatsApp tab
async function openSettings0() {
  const root = renderSettings();
  document.body.appendChild(root);
  await tick(60);
  root.querySelector('[data-tab="license"]')?.click();
  return root;
}
async function openSettings(tierName) {
  await setTier(tierName);
  const root = renderSettings();
  document.body.appendChild(root);
  await tick(60);
  return root;
}
const tab = (root, key) => root.querySelector(`[data-tab="${key}"]`);

let root = await openSettings('pro');
ok('Settings has a WhatsApp tab', !!tab(root, 'whatsapp'));
tab(root, 'license')?.click();
ok('License card lists included pages (WhatsApp Deals locked as Premium)', /Included in your license/.test(root.textContent) && /WhatsApp Deals/.test(root.querySelector('#license-card').textContent) && /Premium/.test(root.querySelector('#license-card').textContent));
ok('License card shows the tier', /Tier/.test(root.querySelector('#license-card').textContent) && /Pro/.test(root.querySelector('#license-card').textContent));
tab(root, 'whatsapp').click();
ok('Pro: WhatsApp speed form is locked with a Premium message (no controls)', /Premium feature/.test(root.querySelector('#whatsapp-card').textContent) && !root.querySelector('#wa-custom-toggle'));
root.remove();

root = await openSettings('premium');
tab(root, 'whatsapp').click();
const wa = () => root.querySelector('#whatsapp-card');
ok('Premium: toggle is shown, OFF by default, no number fields', !!wa().querySelector('#wa-custom-toggle') && wa().querySelector('#wa-custom-toggle').getAttribute('aria-checked') === 'false' && !wa().querySelector('#wa-c-min'));
wa().querySelector('#wa-custom-toggle').click();
const slider = () => wa().querySelector('#wa-speed');
const moveSlider = (i) => {
  slider().value = String(i);
  slider().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  slider().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};
const setField = (id, v) => {
  const i = wa().querySelector(id);
  i.value = String(v);
  i.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};
let saved = null;
posApi.settings.set = async (entries) => {
  saved = entries;
  return entries;
};

ok('Toggle ON shows ONE slider (7 stops) instead of number boxes, resting on Optimized', !!slider() && slider().max === '6' && slider().value === '2' && /Optimized/.test(wa().querySelector('#wa-profile-label').textContent) && /Recommended/.test(wa().querySelector('#wa-profile-label').textContent) && !wa().querySelector('#wa-c-min'));
ok('Slider shows the numbers it stands for (8-25 s, 6-15 min)', /8.{1,8}25 seconds/.test(wa().querySelector('#wa-profile-summary').textContent) && /6.{1,8}15 minutes/.test(wa().querySelector('#wa-profile-summary').textContent));
ok('Optimized: no warning, Save enabled', !wa().querySelector('#wa-accept') && !wa().querySelector('#wa-save').disabled);

moveSlider(0);
ok('Slider to "Very safe": numbers follow (20-45 s, 15-30 min), still no warning', /20.{1,8}45 seconds/.test(wa().querySelector('#wa-profile-summary').textContent) && /Very safe/.test(wa().querySelector('#wa-profile-label').textContent) && !wa().querySelector('#wa-accept') && !wa().querySelector('#wa-save').disabled);
ok('Slower speed makes the estimate longer than Optimized', (() => { const m = wa().textContent.match(/about\s*(?:(\d+) h )?(\d+) min/); return m && ((+m[1] || 0) * 60 + +m[2]) > 120; })());

moveSlider(4);
ok('Slider to "Faster": red warning + responsibility box appear, numbers follow (5-12 s, 3-7 min), Save DISABLED', !!wa().querySelector('#wa-accept') && /your responsibility/.test(wa().textContent) && /5.{1,8}12 seconds/.test(wa().querySelector('#wa-profile-summary').textContent) && wa().querySelector('#wa-save').disabled);
wa().querySelector('#wa-accept').checked = true;
wa().querySelector('#wa-accept').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
ok('Ticking the box enables Save', !wa().querySelector('#wa-save').disabled);
wa().querySelector('#wa-save').click();
await tick(30);
ok('Save sends the stop\'s four numbers and the confirmation flag', saved && saved.whatsapp_timing_custom === '1' && saved.whatsapp_contact_delay_min_s === '5' && saved.whatsapp_contact_delay_max_s === '12' && saved.whatsapp_group_delay_min_min === '3' && saved.whatsapp_group_delay_max_min === '7' && saved.whatsapp_timing_risk_ack_at === '1', JSON.stringify(saved));

moveSlider(4);
ok('Moving the slider again clears the tick (a new speed needs a fresh confirmation)', wa().querySelector('#wa-accept') && !wa().querySelector('#wa-accept').checked && wa().querySelector('#wa-save').disabled);
moveSlider(1);
ok('Back to a safe stop: warning disappears, Save enabled, no confirmation flag sent', (() => { saved = null; return !wa().querySelector('#wa-accept') && !wa().querySelector('#wa-save').disabled; })());
wa().querySelector('#wa-save').click();
await tick(30);
ok('Safe save sends an empty confirmation', saved && saved.whatsapp_timing_risk_ack_at === '' && saved.whatsapp_contact_delay_min_s === '12', JSON.stringify(saved));

// Advanced: exact numbers
wa().querySelector('#wa-advanced-toggle').click();
ok('Advanced opens the four exact-number boxes, prefilled from the slider', wa().querySelector('#wa-c-min').value === '12' && wa().querySelector('#wa-g-max').value === '20');
setField('#wa-c-min', 2);
ok('Advanced: below the hard limit (2 s) shows an error and disables Save', /from 3 to 120/.test(wa().textContent) && wa().querySelector('#wa-save').disabled);
setField('#wa-c-min', 40);
ok('Advanced: shortest above longest shows an error', /cannot be shorter/.test(wa().textContent) && wa().querySelector('#wa-save').disabled);
setField('#wa-c-min', 9);
setField('#wa-c-max', 31);
ok('Advanced: own numbers that match no stop are labelled "Custom"; safe so no warning', /Custom/.test(wa().querySelector('#wa-profile-label').textContent) && !wa().querySelector('#wa-accept') && !wa().querySelector('#wa-save').disabled);
setField('#wa-c-min', 4);
ok('Advanced: custom number faster than safe still triggers the warning and tick', !!wa().querySelector('#wa-accept') && wa().querySelector('#wa-save').disabled);
wa().querySelector('#wa-reset').click();
ok('"Back to Optimized" returns the slider to Optimized (8-25 s / 6-15 min)', slider().value === '2' && /Optimized/.test(wa().querySelector('#wa-profile-label').textContent) && !wa().querySelector('#wa-c-min'));
wa().querySelector('#wa-custom-toggle').click();
ok('Toggle OFF hides the slider and states the Optimized speed', !slider() && /Recommended: 8.{1,8}25 seconds/.test(wa().textContent));
root.remove();

// ---------- Settings > License: several licenses, pause and switch
{
  const { m, st } = await walletStatus();
  current = st;
  posApi.license.getStatus = async () => current;
  await lic.refreshLicense();
  const used = [];
  posApi.license.use = async (slot) => {
    used.push(slot);
    current = await m.useLicense(slot);
    return current;
  };
  const r = await openSettings0();
  const card = r.querySelector('#license-card');
  ok('License tab lists both licenses: Premium running, Pro paused with its days kept', /Your licenses/.test(card.textContent) && /Running/.test(card.textContent) && /Paused/.test(card.textContent) && /days kept/.test(card.textContent));
  ok('Only the paused one has a "Use this" button', card.querySelectorAll('.use-license-btn').length === 1 && card.querySelector('.use-license-btn').dataset.useLicense === 'pro');
  ok('The notice about the upgrade is shown in plain words', /days are paused and kept/.test(card.textContent));
  card.querySelector('.use-license-btn').click();
  await tick(60);
  ok('Pressing "Use this" switches: Pro runs, Premium is paused, the screen updates', used[0] === 'pro' && /Pro/.test(r.querySelector('#license-card').textContent) && r.querySelectorAll('#license-card .use-license-btn')[0]?.dataset.useLicense === 'premium', JSON.stringify(used));
  ok('The pages table now locks WhatsApp Deals (Pro tier is running)', /WhatsApp Deals/.test(r.querySelector('#license-card').textContent) && lic.getTier() === 'pro');
  r.remove();
}

// ---------- typing safety: no native dialogs, and the in-app confirm behaves
{
  const fs = await import('fs');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.js') ? [`${d}/${e.name}`] : []));
  const offenders = walk(path.join(ROOT, 'src')).filter((f) => /(^|[^\w.])(window\.)?(confirm|alert|prompt)\s*\(/.test(fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '')));
  ok('no screen uses a native confirm/alert/prompt (they freeze typing on Windows)', offenders.length === 0, offenders.join(', '));

  const { confirmAction } = await import(pathToFileURL(path.join(ROOT, 'src/shell/confirmDialog.js')).href);
  const box = document.createElement('input');
  box.id = 'search-like';
  document.body.appendChild(box);
  box.focus();
  const pending = confirmAction({ title: '<b>T</b>', message: 'Delete "<img src=x onerror=alert(1)>"?\nSecond line', confirmLabel: 'Delete' });
  await tick(30);
  const dlg = document.body.querySelector('.cf-scrim')?.parentElement;
  ok('confirm dialog shows names as plain text (no HTML injection) and keeps line breaks', !!dlg && !dlg.querySelector('img') && /<img src=x/.test(dlg.textContent) && dlg.querySelector('br'));
  ok('confirm dialog puts the safe button (Cancel) in focus', document.activeElement && document.activeElement.id === 'cf-cancel');
  dlg.querySelector('#cf-cancel').click();
  ok('Cancel resolves false', (await pending) === false);
  ok('after the dialog closes, the text box that had focus gets it back (typing continues)', document.activeElement === box);
  const second = confirmAction({ message: 'x', confirmLabel: 'Go', tone: 'default' });
  await tick(20);
  document.body.querySelector('#cf-confirm').click();
  ok('Confirm resolves true and the dialog is removed', (await second) === true && !document.body.querySelector('.cf-scrim'));
  box.remove();
}

// ---------- unfinished campaign after a crash: banner at the top + "not sure" box on the WhatsApp page
{
  const { createCampaignBanner } = await import(pathToFileURL(path.join(ROOT, 'src/shell/campaignBanner.js')).href);
  const crashed = {
    runState: 'stopped',
    nextGroupAt: null,
    groups: [
      [
        { id: 1, name: 'Ali', phone: '03001', status: 'sent', error: null },
        { id: 2, name: 'Sara', phone: '03002', status: 'uncertain', error: 'The app closed while sending. It may or may not have been delivered.' },
        { id: 3, name: 'Omar', phone: '03003', status: 'pending', error: null },
      ],
    ],
  };
  posApi.whatsapp.getCampaignState = async () => crashed;
  await setTier('premium');
  let opened = 0;
  const banner = createCampaignBanner({ onOpen: () => opened++ });
  document.body.appendChild(banner.el);
  await banner.check();
  ok('app start: a paused campaign shows a bar "1 of 3 sent, 1 not sure" with Continue', /paused: 1 of 3 sent, 1 not sure/.test(banner.el.textContent) && !!banner.el.querySelector('[data-open]'));
  banner.el.querySelector('[data-open]').click();
  ok('Continue opens the WhatsApp page and hides the bar', opened === 1 && banner.el.classList.contains('hidden'));
  const b2 = createCampaignBanner({ onOpen() {} });
  document.body.appendChild(b2.el);
  await setTier('pro');
  await b2.check();
  ok('a Pro license never sees the bar (WhatsApp is Premium)', b2.el.classList.contains('hidden'));
  await setTier('premium');
  posApi.whatsapp.getCampaignState = async () => ({ ...crashed, runState: 'completed' });
  const b3 = createCampaignBanner({ onOpen() {} });
  await b3.check();
  ok('a finished campaign shows no bar', b3.el.classList.contains('hidden'));
  banner.el.remove();
  b2.el.remove();

  // the WhatsApp page itself
  posApi.whatsapp.getCampaignState = async () => crashed;
  posApi.whatsapp.getStatus = async () => ({ status: 'READY', campaignActive: false });
  const asked = [];
  posApi.whatsapp.resolveUncertain = async (a) => {
    asked.push(a);
    crashed.groups[0][1].status = a === 'resend' ? 'pending' : 'failed';
    return { count: 1 };
  };
  const { renderWhatsappDeals } = await import(pathToFileURL(path.join(ROOT, 'src/modules/whatsappDeals.js')).href);
  const page = renderWhatsappDeals();
  document.body.appendChild(page);
  await tick(200);
  ok('WhatsApp page: shows "1 customer: not sure if the message went" with Send again / Skip', /1 customer: not sure if the message went/.test(page.textContent) && !!page.querySelector('#wa-unsure-resend') && !!page.querySelector('#wa-unsure-skip'), page.textContent.slice(0, 200));
  ok('WhatsApp page: the unsure customer is named', /Sara/.test(page.textContent));
  page.querySelector('#wa-unsure-resend')?.click();
  await tick(80);
  ok('"Send again" asks the app to queue them again and the box goes away', asked[0] === 'resend' && !page.querySelector('#wa-unsure-resend'));
  page._cleanup?.();
  page.remove();
}

console.log(failed ? `\n${failed} FAILED` : '\nall UI smoke checks passed');
process.exit(failed ? 1 : 0);
