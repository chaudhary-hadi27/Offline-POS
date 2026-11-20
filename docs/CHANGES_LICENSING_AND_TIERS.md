# What changed (summary)

## 1. Licensing hardened (found by adversarial tests, then fixed)
Dev bypass can no longer be switched on in an installed build. Master secret removed from the repo AND from the app
(see 4). One failed `reg.exe` read no longer locks a customer. Keys made on a PC with a wrong date can be recovered.
Keys pasted from WhatsApp with invisible direction marks work. A running WhatsApp campaign stops when the licence ends.
Activations run one at a time. The issue tool refuses to sign with a wrong PC date and fails loudly without `--tier`.
Installer is per-machine with an `afterPack` fuses hook (ASAR integrity is opt-in).

## 2. Tiers: Free / Pro / Premium
Catalogue in `electron/license/tiers.js`. Free = Settings only, Pro = all pages but WhatsApp Deals, Premium = everything.
Enforced in the main process. Old keys (no tier) run as Premium (`LEGACY_TIER`).

## 3. Several licenses on one PC (new)
One Pro + one Premium can sit on a PC. One runs, the other is paused with its days kept. Premium entered over Pro starts
at once and pauses Pro; "Use this" switches by hand; when one ends the other starts by itself. `--exclusive` keys do
refund / downgrade. Pause is measured with the POS calendar, so it cannot create days. Tested in `qa/license-qa.js` group H.

## 4. Forgot-PIN recovery with a private/public key (new)
The shared master secret is gone. The lock screen shows a challenge; you sign it with `npm run recovery:issue`; the app checks
the signature with a public key. Needs `npm run recovery:keys` once. Builds stop until it exists.
`scripts/compute-master-key.js` stays only for apps built before this change.

## 5. WhatsApp
- Sending speed: one slider with 7 stops (Optimized in the middle), exact numbers under "Advanced". Faster than Optimized needs
  the short tick "I accept the risk". Limits 3-120 s and 1-60 min are enforced in the main process.
- Closing or crashing mid-campaign: the "sending" mark is written to disk BEFORE each send. Next start: a bar says the campaign is
  paused; the customer who was in flight is "not sure" and is never re-sent by itself (Send again / Skip).
- Texts for the licence and the speed warning are now short and plain.

## 6. Typing bug (Search not accepting text in a running app)
Cause: seven native `confirm()` dialogs. On Windows, Electron can leave every text box unable to take typing after one.
All were replaced with the in-app dialog (`confirmAction`, now also escaping text and returning focus). The main window blocks native
dialogs and hands focus back on window focus; a test fails if one is added again.

## 7. Release safety and manual admin
`npm run license:check` (also before `dist:win`) looks inside what the installer will contain. `npm run license:list` shows
customers and expiry dates. See `docs/ADMIN_MANUAL.md`, `docs/RELEASE_GUIDE.md`, `docs/SCENARIOS.md`.

## 8. Still yours to do
1. `npm run license:keys` is already done if you shipped before; run `npm run recovery:keys` ONCE (the build refuses without it).
2. The old master secret is public in the old git history: purge it (or treat old builds as unprotected for PIN reset) and keep
   the old secret only for `scripts/compute-master-key.js` if old installs still need it.
3. Run the Windows checklist in `docs/RELEASE_GUIDE.md`.
4. Decide `LEGACY_TIER`.
5. Known limits of offline licensing remain (see `docs/LICENSING_GUIDE.md`, "Honest limits").
