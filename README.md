# Offline POS

A 100% offline restaurant point-of-sale desktop app for Windows, built with
Electron and SQLite. No internet connection, cloud account, or subscription
required — orders, menu, customers, and reports all live in a local
database on the restaurant's own PC.

## Features

- **New Order** — fast item grid, price variants, live cart, receipt printing
- **Menu Setup** — items, categories, pricing, price variants, availability toggle
- **Order History** — searchable by order #, customer, or phone; date-range filters; reprints
- **Customer Database** — profiles with multiple delivery addresses, order history, spend stats
- **Analytics & Reports** — sales trends, top items, performance charts
- **WhatsApp Deals** — send deal broadcasts to customers straight from the app
- **Business-day aware** — a configurable day-start time (not midnight) drives what counts as "today" across history and reports
- **Secured admin area** — PIN / password / pattern lock with a security-question and master-key recovery path for lockouts
- **Danger Zone + Hidden Records** — soft-delete old orders out of History & Reports; Hidden Records shows live + hidden orders together and is where you permanently delete records when you're sure

## Tech stack

- [Electron](https://www.electronjs.org/) + Node.js — desktop shell, IPC, printing
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — local, file-based database (WAL mode)
- [Vite](https://vitejs.dev/) — renderer bundling
- Vanilla JS (no framework) + [Tailwind CSS](https://tailwindcss.com/)
- [whatsapp-web.js](https://wwebjs.dev/) — WhatsApp Deals

## Getting started

```bash
git clone https://github.com/chaudhary-hadi27/Offline-POS.git
cd Offline-POS
npm install
npm run build:renderer
npm start        # launches the Electron app
```

For renderer-only development with hot reload:

```bash
npm run dev       # Vite dev server (browser preview, mock data layer)
```

## Building the Windows installer

Building a distributable `.exe` requires a one-time master-key secret (used
for the offline PIN-recovery flow). See
[`docs/MASTER_KEY_AND_BUILD_GUIDE.md`](docs/MASTER_KEY_AND_BUILD_GUIDE.md)
for the full walkthrough. Short version:

```powershell
$env:POS_MASTER_SECRET="your-own-long-random-secret"
npm run dist:win
```

The installer is written to `release/`.

## Tests

```bash
npm run db:test          # core repository self-test, no Electron needed
npm run db:test:extended # extended coverage
```

## Project structure

```
electron/        Main process: window/IPC setup, database, printing, WhatsApp, security
src/
  modules/        Feature screens (New Order, Menu Setup, Order History, Customers, ...)
  shell/          App chrome: router, dashboard, command palette, gatekeeper lock
  styles/          Tailwind entry + custom animations
docs/             Build & operations guides
scripts/          One-off build/setup scripts (master key, Chrome bundling)
```

## License

Proprietary — all rights reserved.
