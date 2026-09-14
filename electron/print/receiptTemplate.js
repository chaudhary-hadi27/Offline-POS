'use strict';

/**
 * Renders a receipt as printable HTML sized for an 80mm thermal roll.
 * Pure string templating - no Electron APIs here - so this function
 * can be unit tested with plain Node and reused if we ever add a
 * "reprint preview" screen.
 */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// A bill past this many line items switches to "compact" spacing
// (tighter row/divider margins) below - a genuinely large order
// (big dine-in tables, catering, bulk delivery) otherwise burns
// noticeably more thermal paper on whitespace than on content, and a
// longer roll per receipt is a real, recurring cost on high-volume
// days. Item names/quantities/prices themselves never shrink or get
// abbreviated - only the breathing room between rows tightens up.
const HEAVY_BILL_ITEM_THRESHOLD = 15;

/** Full value, always - never abbreviated to "1.2K". Whole-rupee
 *  amounts (the overwhelming majority here) print without decimals
 *  ("Rs. 12,500") so the number stays compact even when it's large;
 *  a genuine fractional amount still prints its cents in full so
 *  nothing is silently rounded away. */
function money(n) {
  const num = Number(n) || 0;
  const hasFraction = Math.round(num * 100) % 100 !== 0;
  const formatted = num.toLocaleString('en-PK', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `Rs. ${formatted}`;
}

function formatDateTime(iso) {
  const d = new Date(iso.replace(' ', 'T') + 'Z'); // SQLite datetime('now') is UTC, no offset suffix
  return d.toLocaleString('en-PK', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * FALLBACK ONLY - see measureReceiptHeightMm() in printReceipt.js,
 * which measures the receipt's actual rendered height in the hidden
 * print window and uses that instead. This heuristic (guessing the
 * printed height in millimetres from content - header lines, item
 * rows, whether there's a customer block) is kept only as a safety
 * net for the rare case that measurement itself fails, so a print job
 * never goes out with a completely unset page height.
 * Electron's webContents.print() needs a real page HEIGHT for custom
 * paper sizes - it has no equivalent of the CSS "@page { size: 80mm
 * auto }" used above, which is fine for on-screen/PDF rendering but is
 * NOT what actually gets sent to a physical printer via `deviceName`.
 * Without an explicit, matching pageSize, Chromium falls back to a
 * default (Letter/A4-ish) page for the *physical* print job while our
 * CSS still centers a much narrower 80mm-wide receipt inside it - so
 * most of the content lands to the right of the printable 80mm roll
 * width and never reaches the paper. Deliberately erring on the tall
 * side here (rather than exact) is the safe direction: a page a bit
 * too tall just leaves a little blank paper before the next cut, but
 * a page too short truncates real content off the receipt - which is
 * exactly the failure mode a hand-maintained guess is prone to the
 * moment the template above changes without this being updated to
 * match (see the BUG HISTORY note in printReceipt.js).
 */
function estimateReceiptHeightMm(order, settings) {
  const headerLines = String(settings.receipt_header || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const hasCustomerBlock = !!(order.customer_name || order.customer_phone || order.customer_address);
  const customerLineCount = [order.customer_name, order.customer_phone, order.customer_address].filter(Boolean).length;
  // Mirrors buildReceiptHtml()'s own compact-mode threshold below -
  // rows print a touch tighter on heavy bills, so the fallback guess
  // has to shrink its per-row/per-hr numbers to match, or it drifts
  // (tall) exactly on the bills where an accurate guess matters most.
  const isHeavyBill = order.items.length > HEAVY_BILL_ITEM_THRESHOLD;
  const hrMm = isHeavyBill ? 4.5 : 6;
  const perItemMm = isHeavyBill ? 5.5 : 6.5;

  let mm = 0;
  mm += 7; // restaurant name (bold, larger font)
  mm += headerLines.length * 5;
  mm += hrMm; // solid hr under the header
  mm += 5; // "Order #N   date/time" row
  mm += 7; // order-type badge row
  mm += hrMm; // hr
  if (hasCustomerBlock) {
    mm += 4 + customerLineCount * 5 + hrMm; // label + detail lines + trailing hr
  }
  mm += Math.max(order.items.length, 1) * perItemMm; // one row per item (Urdu names print a touch taller)
  mm += hrMm; // hr after items
  mm += 5 + 5 + 8; // subtotal + tax + grand total (larger font, top border, extra padding)
  if (order.delivery_charge) mm += 5; // optional delivery charge row
  mm += hrMm; // hr
  mm += 6; // footer line
  mm += 8; // @page top+bottom margin (4mm each)

  const withBuffer = mm * 1.2 + 20; // generous safety margin - see note above on erring tall
  return Math.min(Math.max(withBuffer, 120), 1500);
}

function buildReceiptHtml(order, settings) {
  const widthMm = settings.receipt_width_mm || '80';
  const restaurantName = settings.restaurant_name || 'Restaurant';
  const footer = settings.receipt_footer || 'Thank you for visiting!';
  const isHeavyBill = order.items.length > HEAVY_BILL_ITEM_THRESHOLD;

  // Header supports multiple lines (e.g. address on one line, phone
  // on the next) - each non-empty line prints as its own centered row
  // instead of being crammed together.
  const headerLines = String(settings.receipt_header || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // The client only wants the Urdu name on the printed receipt - the
  // English name is just a fallback for items that were never given
  // an Urdu name (see item_name_urdu_snapshot / items.name_urdu).
  const lineRows = order.items
    .map((item) => {
      const displayName = item.item_name_urdu_snapshot || item.item_name_snapshot;
      const isUrdu = !!item.item_name_urdu_snapshot;
      return `
      <tr>
        <td class="qty">${item.quantity}x</td>
        <td class="name${isUrdu ? ' urdu' : ''}">${escapeHtml(displayName)}</td>
        <td class="amt">${money(item.total_price)}</td>
      </tr>`;
    })
    .join('');

  const customerBlock =
    order.customer_name || order.customer_phone || order.customer_address
      ? `
      <div class="section">
        <div class="label">${order.order_type === 'Delivery' ? 'DELIVER TO' : 'CUSTOMER'}</div>
        ${order.customer_name ? `<div class="bold">${escapeHtml(order.customer_name)}</div>` : ''}
        ${order.customer_phone ? `<div>${escapeHtml(order.customer_phone)}</div>` : ''}
        ${order.customer_address ? `<div>${escapeHtml(order.customer_address)}</div>` : ''}
      </div>
      <div class="hr"></div>`
      : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  /* 4mm side margins (was 3mm) - most 80mm thermal print heads have a
     couple mm of dead zone right at the paper edge before ink/heat
     transfer is fully reliable, and a slightly wider gutter also
     keeps the price column (below) from ever looking flush against
     the cut edge. printReceipt.js's PAGE_VERTICAL_MARGIN_MM (top +
     bottom) and the body width formula below both have to match this
     number - they're not derived from it automatically. */
  @page { size: ${widthMm}mm auto; margin: 4mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Courier New', Courier, monospace;
    font-size: 12px;
    font-weight: 700;
    line-height: ${isHeavyBill ? '1.3' : '1.45'};
    color: #000;
    width: ${Number(widthMm) - 8}mm;
    margin: 0 auto;
  }
  .center { text-align: center; }
  .bold { font-weight: 700; }
  .name-title { font-size: 16px; letter-spacing: 0.5px; }
  .hr { border-top: 1px dashed #000; margin: ${isHeavyBill ? '6px' : '9px'} 0; }
  .hr-solid { border-top: 1.5px solid #000; margin: ${isHeavyBill ? '6px' : '9px'} 0; }
  .section { margin: ${isHeavyBill ? '5px' : '8px'} 0; }
  .section > div { margin: 2px 0; }
  .label { font-size: 10px; letter-spacing: 0.5px; color: #444; margin-bottom: 3px; }
  .meta-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .meta-row > span:last-child { text-align: right; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: ${isHeavyBill ? '1px' : '2px'} 0; vertical-align: top; }
  td.qty { width: 26px; }
  /* The 3mm right-padding is the "push the numbers back a bit" gutter
     - separate from the @page margin above, so the amount column
     never sits flush against the receipt's own right edge even
     though it's still fully right-aligned within it. */
  td.amt { width: 76px; text-align: right; white-space: nowrap; padding-right: 3mm; }
  /* Urdu item names print right-to-left in the Nastaliq style if the
     printer's system has an Urdu font installed (e.g. "Jameel Noori
     Nastaleeq" or "Noto Nastaliq Urdu"), falling back to whatever
     generic sans-serif font can still render the Arabic script. */
  td.name.urdu {
    direction: rtl;
    text-align: left;
    unicode-bidi: plaintext;
    font-family: 'Jameel Noori Nastaleeq', 'Noto Nastaliq Urdu', 'Noto Naskh Arabic', Tahoma, sans-serif;
    font-size: 14px;
  }
  .totals td { padding-top: 3px; }
  .totals td.label-cell { text-align: left; }
  .totals td.value { text-align: right; padding-right: 3mm; }
  .grand { font-size: 15px; border-top: 1px solid #000; padding-top: 5px !important; }
  .footer { margin-top: 10px; }
  .order-type-badge {
    display: inline-block;
    border: 1px solid #000;
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 10px;
    letter-spacing: 0.5px;
    margin-top: 3px;
  }
</style>
</head>
<body>
  <div class="center bold name-title">${escapeHtml(restaurantName)}</div>
  ${headerLines.map((line) => `<div class="center">${escapeHtml(line)}</div>`).join('')}
  <div class="hr-solid"></div>

  <div class="section">
    <div class="meta-row"><span class="bold">Order #${order.id}</span><span>${formatDateTime(order.created_at)}</span></div>
    <div class="center order-type-badge">${escapeHtml(order.order_type).toUpperCase()}</div>
  </div>
  <div class="hr"></div>

  ${customerBlock}

  <table>${lineRows}</table>
  <div class="hr"></div>

  <table class="totals">
    <tr><td class="label-cell">Subtotal</td><td class="value">${money(order.subtotal)}</td></tr>
    <tr><td class="label-cell">Tax (${order.tax_rate}%)</td><td class="value">${money(order.tax_amount)}</td></tr>
    ${
      order.delivery_charge
        ? `<tr><td class="label-cell">Delivery Charge</td><td class="value">${money(order.delivery_charge)}</td></tr>`
        : ''
    }
    <tr class="bold grand"><td class="label-cell">TOTAL</td><td class="value">${money(order.total)}</td></tr>
  </table>

  <div class="hr"></div>
  <div class="center footer">${escapeHtml(footer)}</div>
</body>
</html>`;
}

module.exports = { buildReceiptHtml, money, formatDateTime, estimateReceiptHeightMm };
