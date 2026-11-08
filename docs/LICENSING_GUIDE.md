# Licensing guide

How the POS licensing works, and how **you (the vendor)** use it day to day.

## The idea in one minute

- You own a **private key** (your "stamp"). Only you have it.
- The app contains the matching **public key**. It can only *check* a stamp, never make one.
- Every PC shows a **Hardware ID**. The customer sends it to you.
- You make a **license key** for that ID and a plan (30 days / 1 year / 3 years / 10 years / custom).
  The key contains the customer name, the Hardware ID and the **expiry date**, all signed.
- The customer pastes the key into *Settings → License*. The app checks three things:
  the signature is yours, the key is for *this* PC, and the date has not passed.

Until a valid license is active the POS is **locked**: only *Settings* (including Backup & Restore)
opens. The main process refuses every other action, so this is not just hidden buttons.
When a license expires the customer's data is never touched or hidden - Settings and Backup keep working.

## One-time setup

1. `npm run license:keys` (or `node tools/license/generate-keys.js`)
   - Choose a long passphrase (4–5 random words). It is not shown while you type.
   - Creates `license-keys/private-1.pem` (**your stamp**, encrypted with the passphrase) and
     writes the public key into `electron/license/publicKeys.js`.
2. **Back up the private key now**: copy `private-1.pem` to a USB drive *and* a second safe place.
   Write the passphrase on paper and keep it somewhere *different* from the key file.
   If you lose the key or the passphrase you cannot issue licenses any more (the only way out is a new
   key pair and a new app version for every customer).
3. Never commit `license-keys/` (already in `.gitignore`) and never put a `.pem` inside `electron/` or `dist/`.
   `npm run dist:win` runs `scripts/check-license-config.js` first and refuses to build if the public key
   is missing or a private key is in the package.
4. `npm run dist:win` to build the installer.

## Giving a customer a license

1. The customer installs the POS, opens it (it goes straight to *Settings → License*), copies the
   **Hardware ID** (Copy button) and sends it to you.
2. On your PC (with the private key available):
   `npm run license:issue` — it asks for the Hardware ID, customer name and plan, then the passphrase.
   Or in one line:
   `node tools/license/issue-license.js --machine A1B2-C3D4-E5F6-7890 --customer "A1 Bite" --plan Y01`
3. Send the whole `POS1.…` text (WhatsApp is fine, line wrapping does not matter).
4. The customer pastes it into *Settings → License → Activate*. The POS unlocks immediately.

Plans: `M30` (30-day trial), `Y01` (1 year), `Y03` (3 years), `Y10` (10 years), `CUSTOM --expires 2027-03-31`.
The term starts on the day **you create the key**, and runs to the end of the expiry day (UTC).
There is no "lifetime" plan on purpose — use `Y10` if a customer insists.

Every key you issue is recorded in `license-keys/issued-licenses.csv` (customer, Hardware ID, plan, expiry).

## Renewing

Make a new key for the **same Hardware ID**. The easy way:

`node tools/license/issue-license.js --machine <ID> --customer "A1 Bite" --plan Y01 --renew`

`--renew` looks up that PC's current expiry in `license-keys/issued-licenses.csv` and starts the new term from it, so
the customer keeps every unused day. (Or give the date yourself: `--extend-from 2027-01-15`.)

The customer pastes the new key into *Settings → License*. **A newer key replaces the old license on the spot** - the POS is
never locked in between, even if the old license has days left (it simply ends and the new one carries on), and an expired POS
unlocks the moment the key is accepted. An *older* key can never replace a newer one, so a stale key cannot be re-entered.
The POS warns for the last 7 days.

## New PC / Windows reinstalled

The Hardware ID comes from Windows itself (`MachineGuid`), so **uninstalling or deleting the POS does not change it**.
Reinstalling Windows or moving to a new PC does. Ask the customer for the new ID and issue a new key
(restoring a backup does not carry the license - that is intended).

Cloning a whole disk to a second PC copies the ID too; that is the one case this design cannot prevent.

## The PC date can never break the POS

The POS keeps **its own calendar** and never relies on the PC clock:

- The calendar only moves forward - by real running time (a timer the PC clock cannot affect), plus the time the POS was switched off.
- Time switched off is read from the PC clock, but **at most 7 days are believed per event**. A date typed as 2035 therefore costs a
  customer at most a week, never locks anything, and nothing needs repairing.
- **Clock put back** (to cheat, or by mistake): no effect except a note in *Settings → License*. Running time still counts; nothing is given back.
- **Dead CMOS battery** (PC starts in 2009): the POS keeps working and counting. When the date is corrected the POS simply adopts it - no lock, no code.
- The license's own issue date is the vendor's real "now", so the calendar is never behind it. A new license (or repair code) re-aligns it.
- If the POS's calendar and the PC date differ by more than 2 days, *Settings → License* says so (and shows the license as it counts).

Effects: a customer who leaves the POS off for weeks effectively gets those days free (only 7 are counted per gap), and several accidental
clock jumps can push the POS calendar a few days ahead. If a customer thinks their term ended too early, send a **repair code**:
`node tools/license/issue-license.js --repair --machine <ID>` (on a PC with the correct date). The customer sets the PC date correctly,
then pastes the `POS1R.…` code. It re-aligns the POS calendar to your real date - in either direction - so it can fix a drift but can never
extend an expiry. It works once and only within 2 days of the date it was made.

The saved copies of the calendar are plain data, so they are not the only proof of time: the **newest order and the last backup time** in the
database are always used as a floor (if they are no more than 10 days ahead of the PC clock). Editing or deleting the saved copies therefore
changes nothing while the restaurant has orders; to hide the real date someone would have to put the PC clock itself back (which makes
receipts and reports show wrong dates) or delete sales history. Corrupt saved values are ignored, never trusted.

Create licenses on a PC with the **correct date**: the issue date in the key is used as a trusted "now".

## Leaked or cracked build

Raise `MIN_LICENSE_EPOCH` in `electron/license/publicKeys.js` (and issue new licenses with `--epoch <n>`) in the next
release. Licenses from before the bump stop working on the new build. Customers on the new build need a new key once.

## Rotating the signing key

`node tools/license/generate-keys.js --kid 2` adds a second key pair. The app accepts licenses from every key listed in
`publicKeys.js`, so old licenses keep working. Issue new ones with `--key license-keys/private-2.pem --kid 2`.

## Development

Run the app unlocked while developing: `POS_LICENSE_DEV=1 npm start`. This works **only** when the app is not packaged;
an installed build has no way to skip the check.

## What was tried to break it (`npm run license:redteam`)

That script plays a cheating customer against the real code and prints what held and what did not.

| Attack | Result |
|---|---|
| Put the PC clock back while running | blocked (running time still counts) |
| Clock typed years ahead | blocked (about a week lost at most, no lock) |
| Edit / zero / delete the saved calendar, PC clock honest, orders exist | blocked (orders are the floor) |
| Corrupt values in the saved calendar | blocked (ignored; the POS still starts) |
| Skip the gate: IPC handlers outside `safeHandle` | none exist (checked) |
| Close the POS every night and put the clock back to closing time | **works, roughly 2x** for a restaurant open 12 h/day - but the PC date falls behind every day, so receipts and reports show wrong dates after a week |
| Edit the saved calendar when there are no orders/backups at all | **works** (nothing to prove the date) - only a trial nobody really used |
| Delete the saved calendar **and** put the PC clock back more than 10 days | **works** - needs the PC date wrong for as long as it is used |
| Revert the whole PC (VM snapshot / disk image) | works, but every order since is lost too |
| Copy Windows MachineGuid to a second PC (needs admin) | works - offline cannot tell two PCs with the same ID apart |
| Re-enter an older, longer key after deleting the license files | works - there is no offline revocation |

Practical answer to the ones that work: use **short terms with renewal** (annual), keep the license record, and look at receipts when visiting a
customer (a wrong date on receipts is the tell-tale sign). Stronger Windows-only detection (reading the system "time changed" events) is possible later.

Two real bugs were found this way and fixed: a corrupt saved-calendar value used to stop the POS from starting, and editing the saved copies
used to be enough to revive an expired license.

## Honest limits

Offline licensing cannot stop a skilled person who edits the app's files. It stops normal customers from copying the
installer and key to another PC, from extending a trial by resetting the date, and from making their own keys. To raise the
cost for attackers further: code-sign the installer, turn on Electron's ASAR integrity fuse
(supported for Windows builds on Electron 30+; this project uses Electron 31) and consider obfuscating the app code.

## Not covered yet

- The Forgot-PIN *master key* still uses the shared secret bundled in the app (`scripts/generate-master-secret-file.js`).
  Anyone who unpacks the app can compute recovery keys for any PC. It should move to the same signed challenge/response scheme.
- Shop details (phone, logo) on the first-run Settings screen are not part of this change.

## Files

| Path | What it is | Shipped to customers? |
|---|---|---|
| `electron/license/*` | verify, lock rules, clock guard, hardware ID | yes |
| `electron/license/publicKeys.js` | your public key(s) | yes |
| `tools/license/*` | key generation + license issuing | **no** |
| `license-keys/` | your private key + `issued-licenses.csv` | **no** (git-ignored) |
| `scripts/check-license-config.js` | build-time safety check | no |
