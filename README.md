# Restaurant POS — Phase 1: Foundational Infrastructure

Offline-first Electron + SQLite backend. This phase contains no UI yet —
it's the data + IPC foundation everything else builds on.

## What's here

```
electron/
  main.js                  Electron entry point, window, all IPC handlers
  preload.js                contextBridge-exposed API -> window.pos.*
  ipc-channels.js            Single source of truth for channel names
  database/
    schema.sql               Full schema + indexes
    db.js                     Connection singleton (WAL mode, pragmas)
    __selftest__.js           Plain-Node test suite (no Electron needed)
    repositories/
      shifts.js               Day Start / Day End, variance calc
      items.js                 Menu CRUD, availability toggle
      orders.js                Transactional order creation, 24h history,
                                 date-range pagination, reprint
      customers.js              Customer + multiple delivery addresses
      security.js                Salted-hash PIN/Password/Pattern + Layer 1
                                   security question (Layer 2 master-key
                                   backdoor is Phase 4 scope)
      settings.js                Key/value app settings
```

## Run the self-test

No Electron, no display needed — exercises every repository against a
real temporary SQLite file:

```
npm install
npm run db:test
```

## Renderer-side API (available once Phase 2 UI is wired up)

```js
// Everything hangs off window.pos, grouped by domain.
const shift = await window.pos.shifts.getOpen();

try {
  const order = await window.pos.orders.create({
    orderType: 'Delivery',
    customerName: 'Ahmed Raza',
    customerPhone: '03001234567',
    customerAddress: 'House 12, Street 4, Lahore',
    taxRate: 5,
    lines: [{ itemId: 1, name: 'Chicken Biryani', quantity: 2, unitPrice: 450 }],
  });
} catch (err) {
  // err.message is a clean, user-safe string — never a raw SQL error
  showToast(err.message);
}
```

## Key architecture decisions worth knowing

- **Shifts, not midnight.** `orders.shift_id` is the real unit of business
  time. A partial unique index guarantees only one shift can be `OPEN` at once.
- **24h default is a *different query path*** from the historical
  date-range lookup (`listRecentOrders` vs `listOrdersByDateRange`), so a
  future refactor can't accidentally merge them into one unbounded scan.
- **Cursor pagination** (`WHERE id < @cursor`) for the recent-orders and
  customer-directory feeds instead of `OFFSET`, which stays fast at any
  row count.
- **order_items snapshots the name + price** at time of sale, so editing
  or deleting a menu item later never rewrites historical receipts.
- **Deleting a menu item with order history is blocked at the DB level**
  (foreign key constraint) — the UI should route staff to "Out of Stock"
  instead.
- **contextIsolation + no nodeIntegration.** The renderer never sees
  `ipcRenderer`, `require`, or `fs` — only the narrow `window.pos.*`
  surface defined in `preload.js`, built from the single channel list in
  `ipc-channels.js`.
- **Consistent IPC envelope.** Every handler returns `{success, data}` or
  `{success:false, error}`; `preload.js` unwraps this so renderer code can
  use plain `try/catch`.

---

# Phase 2: Global App Shell & Navigation UI

Vite + Tailwind + vanilla JS renderer. No framework - the brief calls for
"visual rendering fast ... no bojh [load] on the system," so this stays
dependency-light on purpose.

## What's here

```
index.html                   Vite entry, no external CDN links (offline-first)
src/
  main.js                     Renderer bootstrap
  styles/main.css             Self-hosted fonts, Tailwind layers, every
                                keyframe (ripple, dock reveal, slide, sheet)
  shell/
    app.js                     Orchestrator: mounts router + footer,
                                 the ONE global keydown listener, theme boot
    router.js                   Workspace-slide transitions between routes
    dock.js                     Persistent narrow icon rail (auto-slides in
                                 once inside a module, staggered icon reveal)
    dashboard.js                 Home grid: cashier block + secured admin block
    modulePlaceholder.js          Phase 3/4 stand-in content per module
    commandPalette.js              Ctrl+K, fuzzy match, full keyboard nav
    shortcutBar.js                  Footer hint line + F1 slide-up sheet
    modules.js                       Single registry driving all 4 surfaces
    icons.js                          Hand-authored single-line icon set
    ripple.js                          Click-feedback utility
    state.js                            Minimal pub-sub store
    posApi.js                            window.pos shim (mocks outside Electron)
```

## Run it

```
npm install
npm run build:renderer   # outputs to dist/
npm start                 # launches Electron pointed at dist/index.html
```

For fast UI iteration without relaunching Electron every time:
```
npm run dev               # Vite dev server on :5173, window.pos auto-mocked
```

## Verified, not just written

Built with `vite build` and driven with Playwright (headless Chromium) to
confirm, with real screenshots: the dashboard renders correctly; clicking a
card triggers the workspace slide and the dock auto-reveals with staggered
icons; Ctrl+K opens the palette and fuzzy-matches (`hist` → Order History);
F1 opens the shortcut sheet; secured modules show their lock badge. One real
bug was caught and fixed this way — the dock's tiny lock badge used the same
stroke icon as the larger dashboard badge and anti-aliased into a smudge at
that size, so a dedicated solid-fill micro glyph replaced it.

## Key architecture decisions worth knowing

- **The dock is not present on the dashboard.** Per the brief, it auto-slides
  in only once you leave the dashboard for a module, then persists across
  module-to-module navigation.
- **One workspace-slide direction, applied uniformly.** The brief describes
  old-page-exits-left / new-page-enters-right without distinguishing forward
  vs. back navigation, so `router.js` applies that same motion for every
  route change rather than inventing a back-navigation convention the brief
  never asked for.
- **`modules.js` is the single registry** for the dashboard grid, the dock,
  the command palette, and the footer shortcut hints. Adding a 7th module
  later means editing one array, not four call sites.
- **Self-hosted fonts (`@fontsource/*`), zero CDN links.** A 100%-offline
  restaurant PC may never see the internet after install, so nothing in the
  renderer reaches out to Google Fonts or any external asset host.
- **Phase 2 doesn't gate secured modules.** Clicking Customers/Analytics/
  Settings navigates straight to a placeholder marked "Secured module" -
  the actual PIN/Password/Pattern gatekeeper is Phase 4 scope, kept
  separate so auth logic doesn't get tangled into routing.
- **`posApi.js` mocks `window.pos` outside Electron**, so the whole shell
  can be iterated on on in a plain browser tab via `npm run dev`, without
  waiting on an Electron relaunch for every CSS tweak.

---

# Phase 3: Unsecured Operational Modules (Cashier Side)

Three fully working cashier screens, wired to the real Phase 1 backend
(or the expanded mock when previewing in a browser).

## What's here

```
electron/print/
  receiptTemplate.js          Pure HTML string builder for the thermal
                                receipt (no Electron deps - independently
                                testable). 80mm layout, dashed separators.
  printReceipt.js               Renders the receipt in a hidden BrowserWindow
                                  and sends it to the Windows-configured
                                  printer via webContents.print()
src/modules/
  menuSetup.js                  Category tabs, inline price editing,
                                  availability toggle, add/edit slide-over,
                                  FK-guarded delete
  newOrder.js                    Category tabs + item grid, cart with
                                   order-type/customer fields, auto-print
                                   on submit, F5 reprint-last, Esc clear-cart
  orderHistory.js                 24h default view (cursor pagination) +
                                    explicit date-range route (numbered
                                    pagination), one-click reprint
  shared/printReceipt.js           printAndNotify() - single entry point
                                     both New Order and Order History
                                     call, for consistent toast feedback
src/shell/toast.js               Lightweight success/error notifications
```

## Verified, not just written

Ran a full Playwright script through the real user flow: open a shift →
add 3 menu items across 2 categories → toggle one out of stock → inline-
edit a price → punch a Delivery order for 2 items → auto-print fires →
Order History shows it within 24h → reprint → switch to date-range search
and find it there too. Zero console errors throughout.

Two real bugs were caught this way and fixed, not just noted:
- **Toast/cart overlap** - toasts rendered top-right, directly on top of
  the New Order cart panel's order-type buttons and customer fields
  (which also live top-right). Moved toasts to bottom-center.
- **Stale customer data** - after submitting a Delivery order, the
  customer name/phone/address inputs kept their values, so the next
  order could silently inherit the previous customer's delivery address.
  Now cleared (along with order type, back to Dine-In) after every
  successful submit.

## Key architecture decisions worth knowing

- **Printing is a Windows-driver print, not raw ESC/POS.** Nearly every
  thermal receipt printer sold for Windows ships with a driver, so it
  appears as an ordinary named printer. `printReceipt.js` uses Electron's
  built-in `webContents.print()` targeting `settings.printer_port` (the
  exact Windows printer name, set in Phase 4's Settings module) with
  `silent: true`. If no printer is configured yet, it falls back to a
  normal print dialog. Raw serial/USB ESC/POS bindings were deliberately
  avoided - that requires a specific physical printer to develop against,
  and is exactly the kind of code that looks right in review and fails
  silently on real hardware.
- **Printing is automatic, not a manual step.** Per the brief ("Submit
  dabate hi direct offline receipt print ho kar nikal aayegi"), there's
  no confirmation modal after Complete Order - it prints immediately and
  the cart resets, ready for the next customer.
- **New Order never gets its own shift-start button.** Day Start is
  Settings-gated (Phase 4, admin/secured) by design. If no shift is open,
  New Order shows a calm blocking state pointing to Settings rather than
  quietly adding an unsecured way to open a shift, which would undermine
  the security model the roadmap describes.
- **24h recent and date-range history are genuinely separate code
  paths** (`orders.listRecent` vs `orders.listByRange`), matching the
  Phase 1 backend design - a future change to one can't accidentally
  widen the other into an unbounded query.
- **Module cleanup convention.** New Order attaches a `document`-level
  keydown listener for F5/Esc; it sets `root._cleanup` and `router.js`
  calls it when navigating away, so repeated visits to New Order don't
  stack duplicate listeners over a long cashier shift.
- **The in-memory mock in `posApi.js` grew substantially** this phase
  (full shift/item/order/customer logic, same validation rules as the
  real repositories) specifically so this whole flow could be built and
  regression-tested with Playwright without launching Electron. It's
  dev/test tooling only - the packaged app always has `window.pos` from
  `preload.js` and never touches this code path.

---

# Phase 4: Secured Administrative Modules

The gatekeeper, both recovery layers, and the three admin modules
(Customers, Analytics, Settings).

## What's here

```
electron/security/
  machineId.js               Persistent per-install UUID (userData/machine.id)
  masterKeyRecovery.js         Layer 2 backdoor: daily-rotating, per-machine
                                 HMAC-SHA256 challenge/response, verified with
                                 zero network round-trip
electron/database/repositories/
  security.js                  +getLockType() - safe for the renderer, never
                                 exposes hashes/salts
  analytics.js                  SQL-side aggregation (SUM/GROUP BY) for the
                                  report - never pulls raw order rows for
                                  the metric cards or order-type breakdown
src/shell/
  gatekeeper.js                 PIN/Password/Pattern unlock modal +
                                  both recovery layers, backdrop-blur scrim
  patternLock.js                 Shared 3x3 drag-to-draw widget (used by
                                   both the gatekeeper and Settings' lock
                                   editor - one implementation, not two)
src/modules/
  settings.js                    Day Start/Day End, restaurant/tax/printer
                                   config, lock setup (PIN/Password/Pattern)
  customers.js                    Secured directory, cursor-paginated,
                                    add customer + delivery address
  analytics.js                     Preset/custom date range, metric cards,
                                     SVG bar chart, top items, order-type
                                     breakdown
```

## Verified, not just written

Full Playwright pass through every path: set a PIN lock → gatekeeper
correctly blocks Customers → wrong PIN rejected → correct PIN grants
access → **re-locks when returning to the dashboard**, confirmed by
design (a session stays unlocked while moving between secured modules,
so an admin doing daily reconciliation isn't re-prompted on every click -
but leaving to an unsecured route re-locks it). Both recovery layers
tested end-to-end: Layer 1 wrong answer rejected, correct answer opens
"set a new lock"; Layer 2 correctly detects a missing security question
and offers developer recovery directly, wrong key rejected, correct key
verified and forces a fresh lock. Pattern-lock drawing tested by
simulating real mouse drag events - captured the exact node sequence
drawn, and a pattern set this way successfully unlocked a secured module
later. Analytics tested against three seeded orders across all three
order types - every number (total sales, tax, net sales, per-item
quantities/revenue, per-order-type totals) checked out to the exact
rupee by hand.

## Key architecture decisions worth knowing

- **Layer 2 needs no network round-trip.** The challenge is
  `HMAC(machineId + today's UTC date)`, so the developer can compute the
  matching response offline from just the phone call - no server, no
  internet, matching the "100% offline" requirement even for recovery.
  `POS_MASTER_SECRET` must be set as a real environment variable before
  shipping; the code loudly warns and falls back to an insecure dev value
  if it isn't, so this can't silently ship wrong.
- **Successful Layer 2 recovery clears the existing lock server-side**
  (in the IPC handler, not just the UI), forcing fresh credentials to be
  set before the recovered admin can do anything else - old, forgotten
  credentials never stay live after a recovery.
- **The pattern-lock widget lives in exactly one file.** It's used by
  three different screens (gatekeeper unlock, gatekeeper's post-recovery
  "set new lock", and Settings' lock editor) - all three import the same
  `patternLock.js` rather than three copies of fairly intricate SVG
  drag-drawing code.
- **Analytics never does a full-table scan**, per the brief's explicit
  requirement. `analytics.getSummary()` uses SQL `SUM`/`GROUP BY` bounded
  by the date range - it returns aggregates, not rows.
- **"Net Profit" is reported as Net Sales (excl. tax).** The schema has
  no cost-of-goods-sold tracking, so a true profit figure isn't
  available; labeling it accurately (revenue before tax) beats a
  confidently wrong "profit" number.
- **Gatekeeper session model.** `secureSessionActive` in the router stays
  true across secured-to-secured navigation and resets on any unsecured
  route - balancing security against not re-prompting an admin for every
  single click while they work across Settings/Customers/Analytics.

---

# Phase 5: The Windows Compile Pipeline

Single command, cross-compiled from Ubuntu to a native Windows installer.

## Actually run, not just configured

```
npm install          # also runs postinstall -> electron-builder install-app-deps
npm run dist:win      # vite build + electron-builder --win --x64
```

This was executed for real in the Linux build environment and produced:

- `release/Restaurant POS Setup 1.0.0.exe` - **86MB**, confirmed via `file`
  to be a genuine `PE32 executable (GUI) Intel 80386, for MS Windows,
  Nullsoft Installer self-extracting archive`
- `release/win-unpacked/Restaurant POS.exe` - the unpacked app (180MB,
  includes Chromium/V8 runtime) that the installer installs
- Critically: `better_sqlite3.node` inside the packaged app was verified
  with `file` to be `PE32+ executable (DLL) (GUI) x86-64, for MS Windows`
  - electron-builder's native-rebuild step correctly fetched a **Windows**
  prebuilt binary for the native SQLite addon, not a copy of the Linux
  one. This is the step that silently breaks a lot of cross-compiled
  Electron+native-module apps, so confirming it with an actual byte-level
  file-type check (not just "the build didn't error") mattered here.

Build artifacts aren't included in this delivery (the installer alone is
86MB) - only the source. Run the two commands above on your own machine
to reproduce them.

## What you need on the build machine

- **Wine** (`sudo apt install wine`) - electron-builder shells out to it
  to build the NSIS installer from Linux. Already present in the
  environment this was built in; a fresh Ubuntu machine will need it
  installed once.
- Everything else (Electron itself, electron-builder, NSIS tooling,
  prebuilt native binaries) downloads automatically via `npm install`.

## Before shipping to the client

- **Set `POS_MASTER_SECRET`** as a real environment variable at build
  time (see `electron/security/masterKeyRecovery.js`) - the fallback
  value is intentionally insecure and logs a warning if used.
- **Add a real app icon.** The build currently logs `default Electron
  icon is used reason=application icon is not set` - cosmetic, but worth
  a `.ico` file wired into the `build.win.icon` field before final
  delivery.
- **Printer name.** The client needs to install their thermal printer's
  Windows driver first, then enter its exact printer name in Settings -
  this is what `printReceipt.js` targets.

## What's next (beyond this roadmap)

The 5 phases specified are now all built and verified. Natural follow-ups
if useful: an installed app icon, a signed installer (Windows SmartScreen
otherwise flags unsigned installers), and an auto-update channel if the
client wants to receive future updates without a manual reinstall.

## Troubleshooting: switching between `npm start` and `npm run dist:win`

Running the Windows cross-compile rebuilds the native SQLite addon
*for Windows* in `node_modules/better-sqlite3`. If you then try to run
`npm start` or `npm run db:test` on your Linux dev machine again, you'll
see `invalid ELF header` - that's not a bug, it's Node trying to load a
Windows `.dll` as if it were a Linux binary. Fix it with:

```
rm -rf node_modules/better-sqlite3 && npm install better-sqlite3
```

then rebuild for Windows again right before your next `dist:win` run.

---

# Post-launch fixes (client feedback round 1)

Thirteen issues reported after hands-on use, all fixed and verified.

## What changed

- **Item photos.** Menu Setup now has a photo picker; New Order shows the
  photo on every product card and a small thumbnail on every cart line.
  Images are resized to a small square JPEG *in the browser* (via
  `<canvas>`, see `src/modules/shared/imageResize.js`) before anything
  is sent over IPC, and stored as plain files on disk
  (`userData/item-images/`) - **never as blobs in SQLite**. A menu with
  200 photographed items adds ~5MB of files next to a database that
  stays exactly as small and fast as it was without them.
- **Explicit "Add to cart" button.** Every product card in New Order now
  has a visible `+` button (tapping the rest of the card still works
  too, for speed).
- **Cart: delete + custom price per line.** Each cart line has a remove
  button and an inline-editable price field, for manual discounts or
  price overrides without touching the master menu price.
- **Order History clarity.** Switching to a custom date range now shows
  a persistent accent-colored banner ("Viewing historical orders: Aug 26
  to Sep 1 - not live data"), and the top-right button relabels itself
  to **"Today"** while in that mode, so getting back to live data is
  never a guessing game.
- **Menu Setup availability toggle.** Was solid crimson for *available*,
  which reads as a warning/stop color to most people - now available is
  dark charcoal, out-of-stock is crimson (matching the conventional
  red = stop association), plus an explicit "Available"/"Out of stock"
  text label so it's unambiguous either way.
- **Scheduled Business Hours (auto Day Start).** Settings has a new
  toggle: set a start time and end time *once* (e.g. 3:00 PM - 3:00 AM)
  and the day opens itself automatically going forward - no more
  clicking "Start Day" every morning. Day End still needs a manual cash
  count (see design note below - that part genuinely can't be
  automated). See `src/shell/shiftScheduler.js`.
- **Automated printer selection.** Settings has a "Detect Printers"
  button that calls Electron's real `webContents.getPrintersAsync()` API
  and lists whatever's actually installed on the machine - pick one,
  done. No more typing an exact printer name from memory.
- **Multi-line receipt header.** The header field is now a textarea;
  each line (address, phone, etc.) prints as its own row on the
  receipt instead of being crammed onto one line.
- **Ctrl+K keyboard navigation - real bug, found and fixed.** Arrow-key
  selection was scoped to a listener on the palette's overlay element,
  which only receives events once focus has actually landed inside it.
  Since that focus move happened via `requestAnimationFrame` (async), a
  fast keypress immediately after Ctrl+K could arrive *before* focus
  moved - landing on `document.body` instead, which isn't an ancestor of
  the overlay, so the keystroke was silently dropped. Moved the
  Arrow/Enter handling to a `document`-level listener gated on
  `isOpen()` (matching the pattern `app.js` already uses for its own
  global shortcuts), which doesn't care where focus currently is.
- **Customer address form: added a Cancel button.** It was only
  dismissible by re-clicking the small "+ Address" toggle up top - not
  discoverable. Now there's an explicit Cancel button right next to Save.
- **Smoother Menu Setup updates.** Adding/editing an item used to swap
  the whole table's content instantly. It now fades out, swaps, fades
  back in (~160ms) - the "jerk" is gone.
- **Receipt, redesigned.** Solid double-rule under the total, an
  order-type badge (DELIVERY/DINE-IN/TAKEAWAY), clearer section labels,
  and better spacing throughout - see the "Receipt template" note below.
- **Scalability audit, confirmed clean.** Went through History, Analytics,
  and the new image storage specifically looking for anything that would
  degrade as data grows for years. Analytics was already backed by real
  SQL `GROUP BY`/`JOIN`/`LIMIT` aggregation (`electron/database/
  repositories/analytics.js`) - it was never pulling raw rows into JS to
  begin with. Order History already used cursor/page pagination. The one
  new thing this round (images) was designed from the start to live on
  disk, not in the database, for exactly this reason.

## Design note: why Day End still isn't automatic

Auto Day Start is safe to automate - opening a shift just needs a
timestamp and a configured float. Day End is different: it requires
someone to physically count the cash drawer and compare it against what
the system expected, which is the entire point of the close-day
reconciliation. There's no way to automate a human counting cash. So the
scheduler opens the day for you and, once the end time passes, shows a
one-time reminder to go close it manually - full automation would defeat
the reason Day End exists in the first place.

## Migration safety

`image_path` was added to the `items` table via `ALTER TABLE`, not a
fresh `CREATE TABLE` - the schema.sql `CREATE TABLE IF NOT EXISTS` guard
does nothing for a database that already exists from before this update.
`electron/database/db.js` now runs a small migration step on every
startup that checks for the column and adds it if missing. Verified
against a simulated pre-update database: the existing item survived with
`image_path: null`, and the column was added without touching any other
data.





---

# Phase 4: Secured Administrative Modules

The gatekeeper, both recovery layers, and the three admin modules
(Customers, Analytics, Settings).

## What's here

```
electron/security/
  machineId.js                Persistent per-install fingerprint (random
                                UUID, written once to userData)
  masterKeyRecovery.js          Layer 2: daily-rotating, per-machine
                                 challenge/response via HMAC-SHA256 -
                                 independently verified with a standalone
                                 test script before wiring into Electron
src/shell/
  gatekeeper.js                 PIN/Password/Pattern unlock modal +
                                  both recovery layers, backdrop-blur scrim
  patternLock.js                 Shared 3x3 pattern-drawing widget (used
                                   by both the gatekeeper and Settings'
                                   lock setup - one implementation, not two)
src/modules/
  settings.js                    Day Start/Day End with variance calc,
                                   restaurant/tax/printer config, lock setup
  customers.js                    Secured customer directory with addresses
  analytics.js                     Date-range metrics, SQL-side aggregation
                                     (never pulls raw order rows for the
                                     summary), daily sales chart, top items,
                                     order-type breakdown
```

## Verified, not just written

Every lock type (PIN, Password, Pattern) tested in both directions -
setting it up in Settings AND unlocking through the gatekeeper - including
wrong-credential rejection. Both recovery layers driven end-to-end:
Layer 1 (wrong answer rejected, correct answer opens "set a new lock"),
and Layer 2 (correctly detects when no security question exists and
offers developer recovery directly, wrong key rejected, correct key
verified against the same HMAC derivation tested standalone in Phase 4's
backend work). Confirmed the gatekeeper stays unlocked while moving
between secured modules in one sitting, and correctly re-locks on
returning to the dashboard. Seeded real orders and confirmed every
Analytics number by hand (total sales, tax, net, per-item and
per-order-type breakdowns all matched exact arithmetic).

One real bug caught and fixed: the "This Month" chart showed a single
bar filling the whole width when there was only one day of sales in a
31-day range, because the SQL `GROUP BY day` aggregate is naturally
sparse. Added a zero-fill step in the renderer so the chart always
spans the full requested range regardless of how sparse the data is.

## Key architecture decisions worth knowing

- **Session-based unlock, not per-click.** Once unlocked, the gatekeeper
  doesn't re-prompt while you move between Customers/Analytics/Settings -
  only when you return to the dashboard and go back in. Matches how most
  real admin panels behave, without being annoying during a daily
  reconciliation routine that touches all three screens.
- **No lock configured = open door.** If the admin never sets up a lock,
  secured modules are reachable directly - the gatekeeper only appears
  once something is actually configured. Otherwise there'd be no way to
  reach Settings on first run to set the first lock.
- **Layer 2 needs no network round-trip.** The challenge is derived from
  a persisted per-install fingerprint + today's UTC date, so the
  developer can compute the matching response offline from just the
  code read to them over the phone - verified independently before ever
  touching Electron.
- **Successful recovery forces a fresh lock**, both client-side (routes
  into "set a new lock") and server-side (`clearLock()` fires the moment
  the master key checks out) - a recovered device never keeps running on
  credentials that were just proven forgotten.
- **Pattern-drawing logic lives in exactly one file** (`patternLock.js`),
  used by both the gatekeeper and Settings, rather than two near-duplicate
  SVG/mouse-event implementations drifting apart over time.
- **Analytics never loads a raw order/inventory list.** `getSummary()` is
  three separate SQL aggregate queries (daily totals, top items, order-type
  breakdown) - the brief is explicit that this screen shows "financial
  matrix and parameters" only, not full record dumps.



# Offline-POS
# Offline-POS
# Offline-POS
