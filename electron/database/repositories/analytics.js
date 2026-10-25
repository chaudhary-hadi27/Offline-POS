'use strict';

const { getDb } = require('../db');

/**
 * Everything here is aggregated in SQL, not computed by pulling raw
 * rows into JS. The brief is explicit that this page must never load
 * the full inventory/order list - only the financial summary - so
 * this repository exists specifically to keep that boundary honest:
 * it CANNOT return a raw order or item row, only pre-aggregated numbers.
 */
// SQL expression that turns a UTC created_at into its BUSINESS day
// ("YYYY-MM-DD" of the day it started on): shift to local time, then back
// by the day-start offset, so with a 3 AM day start a 1 AM order still
// belongs to the previous business day.
const BUSINESS_DAY_SQL = `date(created_at, 'localtime', '-' || @dayStartMinutes || ' minutes')`;

function getSummary({ startDate, endDate, dayStartMinutes = 0 }) {
  const db = getDb();
  const params = { startDate, endDate, dayStartMinutes: Number(dayStartMinutes) || 0 };

  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(total), 0)     AS total_sales,
         COALESCE(SUM(tax_amount), 0) AS total_tax,
         COALESCE(SUM(subtotal), 0)   AS net_sales,
         COUNT(*)                     AS order_count
       FROM orders
       WHERE deleted_at IS NULL AND status = 'COMPLETED' AND created_at >= @startDate AND created_at <= @endDate`
    )
    .get(params);

  const dailyBreakdown = db
    .prepare(
      `SELECT ${BUSINESS_DAY_SQL} AS day, SUM(total) AS total
       FROM orders
       WHERE deleted_at IS NULL AND status = 'COMPLETED' AND created_at >= @startDate AND created_at <= @endDate
       GROUP BY day
       ORDER BY day ASC`
    )
    .all(params);

  const topItems = db
    .prepare(
      `SELECT oi.item_name_snapshot AS name,
              SUM(oi.quantity)      AS quantity,
              SUM(oi.total_price)   AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.deleted_at IS NULL AND o.status = 'COMPLETED' AND o.created_at >= @startDate AND o.created_at <= @endDate
       GROUP BY oi.item_name_snapshot
       ORDER BY revenue DESC
       LIMIT 10`
    )
    .all(params);

  const orderTypeBreakdown = db
    .prepare(
      `SELECT order_type, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
       FROM orders
       WHERE deleted_at IS NULL AND status = 'COMPLETED' AND created_at >= @startDate AND created_at <= @endDate
       GROUP BY order_type`
    )
    .all(params);

  return {
    totalSales: totals.total_sales,
    totalTax: totals.total_tax,
    netSales: totals.net_sales,
    orderCount: totals.order_count,
    dailyBreakdown,
    topItems,
    orderTypeBreakdown,
  };
}

/**
 * Reports half of the Hidden Records view - the same shape as
 * getSummary() above, but with a `scope`:
 *   'all' (default) - live + hidden orders together
 *   'live'          - deleted_at IS NULL
 *   'deleted'       - deleted_at IS NOT NULL (what Danger Zone hid)
 * Only COMPLETED orders count, same as the live Reports. Omitting
 * startDate/endDate covers all time. Dates are passed through exactly
 * as the Reports screen sends them (UTC), so no conversion here.
 */
function getDeletedSummary({ startDate = null, endDate = null, scope = 'all', dayStartMinutes = 0 } = {}) {
  const db = getDb();
  const params = {};
  let dateClause = '';
  if (startDate) {
    dateClause += ' AND created_at >= @startDate';
    params.startDate = startDate;
  }
  if (endDate) {
    dateClause += ' AND created_at <= @endDate';
    params.endDate = endDate;
  }
  const scopeClause =
    scope === 'live' ? 'deleted_at IS NULL' : scope === 'deleted' ? 'deleted_at IS NOT NULL' : '1 = 1';
  const where = `WHERE ${scopeClause} AND status = 'COMPLETED'${dateClause}`;
  const whereJoined = where
    .replaceAll('deleted_at', 'o.deleted_at')
    .replaceAll('status', 'o.status')
    .replaceAll('created_at', 'o.created_at');

  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(total), 0)     AS total_sales,
         COALESCE(SUM(tax_amount), 0) AS total_tax,
         COALESCE(SUM(subtotal), 0)   AS net_sales,
         COUNT(*)                     AS order_count
       FROM orders
       ${where}`
    )
    .get(params);

  const dailyBreakdown = db
    .prepare(
      `SELECT ${BUSINESS_DAY_SQL} AS day, SUM(total) AS total
       FROM orders
       ${where}
       GROUP BY day
       ORDER BY day ASC`
    )
    .all({ ...params, dayStartMinutes: Number(dayStartMinutes) || 0 });

  const topItems = db
    .prepare(
      `SELECT oi.item_name_snapshot AS name,
              SUM(oi.quantity)      AS quantity,
              SUM(oi.total_price)   AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${whereJoined}
       GROUP BY oi.item_name_snapshot
       ORDER BY revenue DESC
       LIMIT 10`
    )
    .all(params);

  const orderTypeBreakdown = db
    .prepare(
      `SELECT order_type, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
       FROM orders
       ${where}
       GROUP BY order_type`
    )
    .all(params);

  return {
    totalSales: totals.total_sales,
    totalTax: totals.total_tax,
    netSales: totals.net_sales,
    orderCount: totals.order_count,
    dailyBreakdown,
    topItems,
    orderTypeBreakdown,
  };
}

module.exports = { getSummary, getDeletedSummary };
