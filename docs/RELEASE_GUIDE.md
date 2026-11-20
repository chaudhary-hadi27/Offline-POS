# Release guide: build the installer safely

## One time only (keep the results safe)
1. `npm run license:keys` creates your **licence** key pair.
   `license-keys/private-1.pem` stays on your PC. The public half goes into `electron/license/publicKeys.js`.
2. `npm run recovery:keys` creates the **Forgot-PIN** key pair (a different pair on purpose).
   `license-keys/recovery-private-1.pem` stays on your PC. The public half goes into `electron/security/recoveryPublicKeys.js`.
3. Back up the whole `license-keys/` folder to a USB drive AND one more safe place. Keep the passphrase somewhere else.
   Lose the private key = you can no longer make keys / PIN resets for the apps already installed.
4. Never commit `license-keys/`. It is git-ignored. `npm run license:check` also fails if a secret is tracked or would be packaged.

## Every release
```
npm ci
npm run qa:all            licence, tiers, wallet, recovery, WhatsApp, release check, red-team
npm run qa:ui             (needs: npm i --no-save jsdom) screens: tiers, wallet, WhatsApp, typing
npm run db:test:all       database, backup and licence self-tests
npm run license:check     the release pre-flight (it also runs by itself before the build)
npm run dist:win          builds the installer into release/
```
`license:check` STOPS the build if: a licence or recovery public key is missing, a private key / old secret / self-test file would be
inside the installer, the dev bypass is not excluded, a new page is missing from `electron/license/tiers.js`, or git tracks a secret.
It only WARNS if the installer is per-user or the fuses hook is missing.

## Test the installed app on a real Windows PC (30 minutes, once per release)
| # | Do this | You should see |
|---|---|---|
| 1 | Install, open, go to Settings > License | A Hardware ID is shown. Only Settings opens (Free). |
| 2 | Paste a Pro key | Pages open. WhatsApp Deals shows a PREMIUM tag and refuses with a short message. |
| 3 | Paste a Premium key | Premium starts at once. The License tab shows Pro as "Paused, N days kept". |
| 4 | Press "Use this" on Pro, then on Premium | The running license switches. Days of the paused one stay the same. |
| 5 | Close the app and open it again | Same license running, same days. |
| 6 | Copy the installed `Restaurant POS.exe` to `electron.exe` in the same folder, set `POS_LICENSE_DEV=1`, start it | It must NOT skip the licence check (still Free). |
| 7 | Set `ELECTRON_RUN_AS_NODE=1` and start the exe | It must NOT run as plain Node (fuses). Also try `--inspect`. |
| 8 | Look in `resources/` of the install folder | No `devBypass.js`, no `.pem`, no `master-secret`. |
| 9 | Change the PC date +1 year, open, change it back | No lock, a small warning at most. |
| 10 | Send a 3-customer WhatsApp campaign, close the app while it sends, reopen | A bar at the top says it is paused. Open it: Resume works. At most one customer shows "not sure". |
| 11 | Lock screen > Forgot PIN > Developer recovery | A challenge like A1B2-C3D4 is shown. `npm run recovery:issue` gives a PR1. code. Pasting it unlocks. |
| 12 | Type in Search after using any Delete / Clear button | Typing works (no native dialog is used). |
| 13 | Try `POS_ASAR_INTEGRITY=1 npm run dist:win` on a spare build | App starts. If it does not start, do not ship with that switch. |
| 14 | Uninstall and install over an old version | Data, license and wallet are still there. |

## If a private key is lost or leaked
- **Lost:** you cannot issue new keys or PIN resets for installed apps. Make a new key pair (`--kid 2`), ship a new version, and re-issue keys to customers.
- **Leaked:** anyone could make keys. Make a new key pair, raise `MIN_LICENSE_EPOCH` in `electron/license/publicKeys.js`, ship a new version, re-issue keys with the new epoch. Old keys stop working in the new version.
