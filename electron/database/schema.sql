-- =============================================================
-- Restaurant POS - SQLite Schema
-- Design notes:
--  - "Day" != midnight. A shift is the real unit of business time.
--    Every order is tied to shift_id, not to a calendar day.
--  - Order History defaults to a 24-hour rolling window for speed.
--    idx_orders_created_at makes that WHERE clause index-only.
--  - order_items snapshots item_name_snapshot + unit_price so that
--    editing/deleting a menu item later never corrupts old receipts.
--  - customers/customer_addresses are normalized (1-to-many) instead
--    of a single address column, since the brief explicitly calls
--    out "multiple delivery addresses" per customer.
-- =============================================================

PRAGMA foreign_keys = ON;

-- ---------- SHIFTS (Day Start / Day End) ----------
CREATE TABLE IF NOT EXISTS shifts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    opened_by       TEXT,
    open_time       TEXT NOT NULL DEFAULT (datetime('now')),
    close_time      TEXT,
    opening_float   REAL NOT NULL DEFAULT 0,
    closing_cash    REAL,
    expected_cash   REAL,
    variance        REAL,
    status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED'))
);

-- Only one shift should ever be OPEN at a time. This partial unique
-- index enforces that at the database level, not just in app code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_single_open
    ON shifts (status)
    WHERE status = 'OPEN';

-- ---------- ITEMS (Menu Setup) ----------
CREATE TABLE IF NOT EXISTS items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    sku             TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    name_urdu       TEXT,
    category        TEXT NOT NULL,
    price           REAL NOT NULL CHECK (price >= 0),
    is_available    INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
    image_path      TEXT,
    description     TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_category   ON items (category);
CREATE INDEX IF NOT EXISTS idx_items_available  ON items (is_available);

-- Optional per-item price options (e.g. Small/Medium/Large). An item
-- with zero rows here is a plain single-price item (items.price is
-- used directly) - this table only ever ADDS choices, it never
-- replaces items.price, so every existing item keeps working exactly
-- as before with no migration needed.
CREATE TABLE IF NOT EXISTS item_price_variants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    price       REAL NOT NULL CHECK (price >= 0),
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_item_price_variants_item ON item_price_variants (item_id);

-- ---------- CUSTOMERS (secured directory) ----------
CREATE TABLE IF NOT EXISTS customers (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    phone             TEXT NOT NULL UNIQUE,
    phone_normalized  TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers (phone);
CREATE INDEX IF NOT EXISTS idx_customers_name  ON customers (name);
-- idx_customers_phone_normalized is created in db.js (after migrations
-- run), not here - on an existing/old database the phone_normalized
-- column doesn't exist yet at the point schema.sql executes, so an
-- unconditional CREATE INDEX here would crash startup on upgrade.

CREATE TABLE IF NOT EXISTS customer_addresses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id   INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    label         TEXT,              -- e.g. "Home", "Office"
    address       TEXT NOT NULL,
    is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON customer_addresses (customer_id);

-- ---------- ORDERS ----------
CREATE TABLE IF NOT EXISTS orders (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id            INTEGER NOT NULL REFERENCES shifts (id),
    customer_id         INTEGER REFERENCES customers (id),
    customer_name       TEXT,
    customer_phone      TEXT,
    customer_address    TEXT,
    order_type          TEXT NOT NULL CHECK (order_type IN ('Dine-In', 'Takeaway', 'Delivery')),
    subtotal            REAL NOT NULL DEFAULT 0,
    tax_rate            REAL NOT NULL DEFAULT 0,
    tax_amount          REAL NOT NULL DEFAULT 0,
    delivery_charge     REAL NOT NULL DEFAULT 0,
    total               REAL NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    status              TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'VOID', 'REFUNDED')),
    deleted_at          TEXT
);

-- This is the single most important index in the whole schema:
-- Order History's default view filters created_at >= now-24h and
-- sorts DESC. Without this, that becomes a full table scan once
-- the orders table grows into the hundreds of thousands of rows.
CREATE INDEX IF NOT EXISTS idx_orders_created_at   ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_shift        ON orders (shift_id);
CREATE INDEX IF NOT EXISTS idx_orders_status_time  ON orders (status, created_at DESC);
-- Settings > Danger Zone soft-deletes orders (deleted_at set) instead
-- of removing rows, so the customer's underlying record/history never
-- gets destroyed - see deleteOrdersInRange() in orders.js. Every read
-- path (Order History, Reports & Analytics, a customer's own order
-- list) filters WHERE deleted_at IS NULL, so this index keeps that
-- filter cheap.
-- idx_orders_deleted_at is created in db.js (after migrations run),
-- not here - on an existing/old database the deleted_at column
-- doesn't exist yet at the point schema.sql executes, so an
-- unconditional CREATE INDEX here would crash startup on upgrade
-- (same reasoning as idx_customers_phone_normalized above).

-- ---------- ORDER ITEMS ----------
CREATE TABLE IF NOT EXISTS order_items (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id            INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    item_id             INTEGER REFERENCES items (id),
    item_name_snapshot  TEXT NOT NULL,
    item_name_urdu_snapshot TEXT,
    quantity            INTEGER NOT NULL CHECK (quantity > 0),
    unit_price          REAL NOT NULL,
    total_price         REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);

-- ---------- SECURITY CONFIG (Gatekeeper) ----------
-- Single-row table (id is always 1). Stores only hashes, never
-- plaintext PIN/password/pattern.
CREATE TABLE IF NOT EXISTS security_config (
    id                      INTEGER PRIMARY KEY CHECK (id = 1),
    lock_type               TEXT NOT NULL CHECK (lock_type IN ('PIN', 'PASSWORD', 'PATTERN')),
    credential_hash         TEXT NOT NULL,
    credential_salt         TEXT NOT NULL,
    security_question       TEXT,
    security_answer_hash    TEXT,
    security_answer_salt    TEXT,
    updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- APP SETTINGS (key/value) ----------
-- Restaurant title, tax base, printer port, receipt header lines, etc.
CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT
);

INSERT OR IGNORE INTO app_settings (key, value) VALUES ('restaurant_name', 'A1 Bite Pizza');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('default_tax_rate', '0');
-- Flat delivery fee (Settings > Restaurant & Receipt), applied on top
-- of subtotal + tax for order_type = 'Delivery' only. Stored per-order
-- in orders.delivery_charge at the time of sale (same snapshot
-- reasoning as everything else here) so changing this later never
-- rewrites an old receipt's total.
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('delivery_charge', '0');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('receipt_header', '');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('receipt_footer', 'Thank you for visiting!');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('printer_port', '');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('theme_mode', 'light');
-- Scheduled business hours: also decides what counts as "Today" in
-- Order History (see src/shell/businessDay.js). New Order never
-- blocks on this - see electron/database/repositories/orders.js,
-- which silently opens a shift behind the scenes if none is open.
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('auto_day_start_enabled', '0');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('day_start_time', '15:00');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('day_end_time', '03:00');

-- ---------- WHATSAPP DEAL SENDER: TEMPLATES ----------
-- Lets a non-technical admin reuse a deal message/image instead of
-- retyping it every time (Friday Deal, Eid Special, etc).
CREATE TABLE IF NOT EXISTS whatsapp_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    message     TEXT NOT NULL,
    image_path  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- NOTE: Campaign "history" (who was sent what, sent/failed status) is
-- intentionally NOT a database table. Jin's call: it lives only in
-- main-process memory + a single overwritten JSON snapshot on disk
-- (electron/whatsapp/campaignStore.js), and is wiped by "New Campaign".
-- Nothing about past sends is kept long-term.
