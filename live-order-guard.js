'use strict';

const ACTIVE_SUPER_ORDER_STATUSES = new Set(['TRANSIT', 'PENDING', 'PART_TRADED', 'TRADED']);
const TERMINAL_SUPER_ORDER_STATUSES = new Set(['REJECTED', 'CANCELLED', 'CLOSED']);
const ACTIVE_REGULAR_ORDER_STATUSES = new Set(['TRANSIT', 'PENDING', 'PART_TRADED']);
const TERMINAL_REGULAR_ORDER_STATUSES = new Set(['REJECTED', 'CANCELLED', 'TRADED', 'EXPIRED']);

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

function isActiveRegularOrder(order) {
  return ACTIVE_REGULAR_ORDER_STATUSES.has(String(order?.orderStatus || '').toUpperCase());
}

function findActiveRegularOrder(orders, underlying) {
  return (Array.isArray(orders) ? orders : []).find((order) =>
    isActiveRegularOrder(order) && orderMatchesUnderlying(order, underlying));
}

function isTerminalRegularOrder(order) {
  return TERMINAL_REGULAR_ORDER_STATUSES.has(String(order?.orderStatus || '').toUpperCase());
}

function countLiveExposure(positions, superOrders, regularOrders, liveSubmissionLocks, underlyings) {
  const openPositions = positions.filter((position) => Number(position.netQty) !== 0);
  const symbols = Array.from(underlyings);
  const reservations = new Set();
  const addReservation = (symbol, fallback) => {
    if (symbol && !openPositions.some((position) => orderMatchesUnderlying(position, symbol))) reservations.add(symbol);
    else if (!symbol && fallback) reservations.add(fallback);
  };
  const addOrder = (order, isActive, prefix) => {
    if (!isActive(order)) return;
    const name = String(order.tradingSymbol || order.securityName || '').toUpperCase();
    const symbol = symbols.find((candidate) => orderMatchesUnderlying(order, candidate));
    addReservation(symbol, `${prefix}:${order.orderId || order.correlationId || order.securityId || name}`);
  };

  for (const order of superOrders) {
    addOrder(order, (item) => ACTIVE_SUPER_ORDER_STATUSES.has(String(item.orderStatus || '').toUpperCase()), 'super-order');
  }
  for (const order of regularOrders) addOrder(order, isActiveRegularOrder, 'regular-order');
  for (const symbol of liveSubmissionLocks.keys()) addReservation(symbol, null);
  return openPositions.length + reservations.size;
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

function isReconciledOrderTerminal(superOrders, regularOrders, reservation) {
  const matchedOrders = [
    { order: findReconciledOrder(superOrders, reservation), isTerminal: isTerminalSuperOrder },
    { order: findReconciledOrder(regularOrders, reservation), isTerminal: isTerminalRegularOrder }
  ].filter(({ order }) => Boolean(order));
  return matchedOrders.length > 0 && matchedOrders.every(({ order, isTerminal }) => isTerminal(order));
}

module.exports = {
  findActiveSuperOrder,
  findActiveRegularOrder,
  isActiveRegularOrder,
  isTerminalRegularOrder,
  countLiveExposure,
  isTerminalSuperOrder,
  findReconciledOrder,
  isReconciledOrderTerminal,
  orderMatchesUnderlying
};
