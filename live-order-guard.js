'use strict';

const ACTIVE_SUPER_ORDER_STATUSES = new Set(['TRANSIT', 'PENDING', 'PART_TRADED', 'TRADED']);
const TERMINAL_SUPER_ORDER_STATUSES = new Set(['REJECTED', 'CANCELLED', 'CLOSED']);

function orderMatchesUnderlying(order, underlying) {
  const name = String(order?.tradingSymbol || order?.securityName || '').toUpperCase();
  const symbol = String(underlying || '').toUpperCase();
  return name === symbol || name.startsWith(`${symbol}-`) || name.startsWith(`${symbol} `);
}

function findActiveSuperOrder(orders, underlying) {
  return (Array.isArray(orders) ? orders : []).find((order) =>
    ACTIVE_SUPER_ORDER_STATUSES.has(String(order?.orderStatus || '').toUpperCase())
    && orderMatchesUnderlying(order, underlying));
}

function isTerminalSuperOrder(order) {
  return TERMINAL_SUPER_ORDER_STATUSES.has(String(order?.orderStatus || '').toUpperCase());
}

function findReconciledOrder(orders, reservation) {
  if (!reservation) return undefined;
  return (Array.isArray(orders) ? orders : []).find((order) =>
    (reservation.correlationId && order?.correlationId === reservation.correlationId)
    || (reservation.orderId && order?.orderId === reservation.orderId));
}

module.exports = { findActiveSuperOrder, isTerminalSuperOrder, findReconciledOrder, orderMatchesUnderlying };
