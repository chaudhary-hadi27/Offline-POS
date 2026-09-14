# Master Key + Building the .exe — Step by Step

This covers two things you do **once as the developer**, on your own computer:

1. Set your secret "master key" phrase (only you ever know this).
2. Build the final `.exe` installer to give to a restaurant.

---

## PART 1 — Set your Master Secret (do this once, ever)

This is the master password behind the "Forgot PIN → call developer" recovery
screen. You never tell this phrase to anyone. You only use it to compute a
one-time code when a customer calls you locked out.

### Step 1 — Pick a secret phrase

Anything at least 16 characters, random-ish. Example only — pick your own:

```
SmartKode-Restaurant-Master-2026-XyZ
```

Write it down somewhere safe (a password manager, a notes app, a locked
file). **If you lose it, you can never unlock any customer's app again — a
new secret means old installs and new installs won't match.** Use the exact
same secret forever, for every restaurant you ever sell this POS to.

### Step 2 — Set it in your terminal, then build

**Windows (PowerShell):**
```powershell
$env:POS_MASTER_SECRET="SmartKode-Restaurant-Master-2026-XyZ"
npm run dist:win
```

**Mac/Linux terminal:**
```bash
POS_MASTER_SECRET="SmartKode-Restaurant-Master-2026-XyZ" npm run dist:win
```

That's it — `npm run dist:win` automatically bakes your secret into the app
*before* it builds the `.exe` (via `scripts/generate-master-secret-file.js`,
which runs as a `predist:win` step — you don't call it separately).

⚠️ **Important:** setting the env var only lasts for that one terminal
session/command. Every time you open a new terminal to build a new version,
set `POS_MASTER_SECRET` again first with the *same* phrase. If you forget
and build without it, the terminal will print a big warning and the app
will fall back to an insecure test key — don't ship that build.

### Note — WhatsApp needs Chrome bundled into the .exe

`npm run dist:win` also runs `scripts/download-chrome.js` automatically
(another `predist:win` step). This downloads the Chrome browser the
WhatsApp Deals feature needs into a project folder (`.puppeteer-cache`),
which then gets packed straight into the installer.

Without this step, WhatsApp would connect fine on your own computer (since
`npm install` already downloaded Chrome to *your* computer) but fail with
"Connection failed" on every restaurant's computer, since Chrome was never
actually inside the installer they ran. As long as you always build with
`npm run dist:win` (not a manual `electron-builder` call), this is handled
for you and there's nothing extra to remember.

### Step 3 — When a customer calls locked out

1. They open the app, hit "Forgot PIN" → "Call developer", and read you an
   8-character code, like `A1B2-C3D4`.
2. On your computer, in the project folder, run:
   ```bash
   npm run master-key
   ```
   (make sure `POS_MASTER_SECRET` is set in that terminal the same way as
   in Step 2 — or just re-run the export/`$env:` line first)
3. It asks you to paste the code. Paste it exactly as they read it
   (dashes are fine either way).
4. It prints a 10-character response key. Read that back to them.
5. They type it in and they're unlocked, then set a brand new PIN.

You can also skip the interactive prompt and do it in one line:
```bash
node scripts/compute-master-key.js A1B2-C3D4
```

**Good to know:** the code changes every day and is different for every
computer, so an old code from last week (or from a different restaurant's
computer) will never work again — that's intentional, it stops the code
from being reused or shared around.

---

## PART 2 — Building the .exe

### One-time setup (only the very first time, on a fresh computer)

1. Install [Node.js](https://nodejs.org) (the LTS version).
2. Open a terminal in the project folder and run:
   ```bash
   npm install
   ```
   This downloads everything the app needs. It also downloads a real Chromium
   browser for the WhatsApp feature, so it can take a few minutes the first
   time — that's normal, just let it finish.

### Every time you want to build a new .exe

```bash
POS_MASTER_SECRET="your-secret-phrase" npm run dist:win
```
(PowerShell users: use the two-line `$env:...` version from Part 1, Step 2.)

This does three things automatically, in order:
1. Bakes your master secret into the app (Part 1).
2. Builds the on-screen app itself (`vite build`).
3. Packages everything into a Windows installer.

When it finishes, look in the **`release/`** folder — you'll find something
like:

```
release/Restaurant POS Setup 1.0.0.exe
```

**That single file is what you give to the restaurant.** They double-click
it, click through the install wizard, and it puts a desktop shortcut on
their PC. No internet needed to install or run it.

### Quick checklist before you hand over an .exe

- [ ] Ran `npm run db:test:all` and every check said `ok` (catches database
      bugs before a customer ever sees them)
- [ ] Set `POS_MASTER_SECRET` in the same terminal command as the build
      (check for the "no real POS_MASTER_SECRET found" warning — if you see
      it, stop and re-run with the secret set)
- [ ] Tested the `.exe` yourself on a Windows PC: open the app, add an item,
      make a test order, print/preview a receipt, connect WhatsApp once
- [ ] Renamed/versioned the file if this replaces an older release, so you
      always know which `.exe` a given restaurant is running

### If something goes wrong

- **"electron-builder command not found"** → run `npm install` again first.
- **Build finishes but the app won't open on the customer's PC** → make sure
  you built with `--win --x64` (already the default in `npm run dist:win`)
  and that their PC is 64-bit (virtually all modern Windows PCs are).
- **You forgot your master secret** → there is no way to recover it. You'll
  need to pick a new one and every existing installed app will need a
  fresh install/update carrying the new secret before recovery works again
  for them. This is why Step 1 says to write it down somewhere safe.

---

## PART 3 — Connecting WhatsApp for real (and how to tell if it's actually connected)

### Are you looking at the real app, or a browser preview?

This matters more than anything else here. If you ever open the app by
typing `npm run dev` and viewing it in a normal Chrome/Edge tab (handy for
quickly checking a UI change), the WhatsApp screen there **cannot connect
to real WhatsApp at all** — a browser tab has no way to run the real
background browser that WhatsApp automation needs. That only exists inside
the actual Electron app.

We fixed a bug where that browser-preview version used to fake a
"Connected" status after a couple seconds, which looked exactly like a
real connection — that's almost certainly what you saw. It now clearly
says *"WhatsApp only works in the installed desktop app - this browser
preview cannot connect for real"* instead, in red, so it can never be
mistaken for a real connection again. **Always test the real WhatsApp
feature by running `npm start` (or the installed `.exe`), never
`npm run dev` in a browser tab.**

### Step-by-step: connecting for real

1. Open the actual desktop app (`npm start`, or the installed `.exe`).
2. Go to **WhatsApp Deals** in the sidebar.
3. Click **Connect WhatsApp**. Wait a few seconds — the badge will say
   "Starting..." then "Scan QR code", and a real black-and-white QR image
   will appear on screen.
4. On your phone: open WhatsApp → **Settings** (or the ⋮ menu) →
   **Linked Devices** → **Link a Device** → scan the QR code on your
   computer screen.
5. Within a few seconds the badge turns green and says **"Connected"**.
   That's it — you only ever do this once. It remembers the session even
   after closing and reopening the app.

### How to actually verify it's real (don't just trust the green badge)

- Select one customer (maybe yourself, with your own number saved as a
  test customer), write a short message, and send it. If a real WhatsApp
  message actually lands on that phone, it's genuinely connected.
- Check your phone's WhatsApp → Linked Devices list — your computer
  should be listed there by name once truly connected.

### If it says "Connected" but nothing actually sends

This means the saved session on your computer has gone stale (most
commonly because the phone unlinked the device, or WhatsApp logged it out
remotely). Fix it by forcing a completely fresh session:

1. In the app, click **Log out** on the WhatsApp Deals screen.
2. Click **Connect WhatsApp** again and scan a brand new QR code.

If that still doesn't help, the session file itself may be corrupted.
Close the app entirely, then delete this folder, then reopen the app and
reconnect from scratch:

```
%APPDATA%\restaurant-pos\whatsapp-session
```

(That's the Windows path — it's wherever `app.getPath('userData')` points
for this app, with a `whatsapp-session` folder inside it.)

### A few honest limitations worth knowing

- This automates the real WhatsApp Web in the background — if WhatsApp
  changes something on their end, an update to the `whatsapp-web.js`
  library may eventually be needed. This isn't an official WhatsApp
  Business API integration; it's the same kind of automation many small
  tools use, and it comes with the small ongoing maintenance cost of
  that approach.
- Sending stops working the moment the phone the QR was scanned from
  goes without internet for too long, or if WhatsApp logs the linked
  device out — the "Log out → reconnect" steps above always fix that.

