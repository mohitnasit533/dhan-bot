'use strict';

const { indiaDate, indiaMinuteOfDay, isSquareOffTime } = require('./risk-controls');

const ACTIVE_ORDER_STATUSES = new Set(['TRANSIT', 'PENDING', 'PART_TRADED']);
const TERMINAL_ORDER_STATUSES = new Set(['CANCELLED', 'REJECTED', 'EXPIRED', 'TRADED', 'CLOSED']);
const ACTIVE_LEG_STATUSES = new Set(['TRANSIT', 'PENDING', 'PART_TRADED']);
const REVIEW_INTERVAL_MS = 10 * 1000;
const MARKET_FALLBACK_MINUTE = 14 * 60 + 59;
const MARKET_CLOSE_MINUTE = 15 * 60 + 30;

function statusOf(order) {
  return String(order?.orderStatus || '').toUpperCase();
}

function findTrackedSuperOrder(superOrders, trade) {
  return superOrders.find((order) =>
    (trade.orderId && String(order.orderId) === String(trade.orderId))
    || (trade.correlationId && order.correlationId === trade.correlationId));
}

function findTrackedExitOrder(regularOrders, trade) {
  return regularOrders.find((order) =>
    (trade.eodExitOrderId && String(order.orderId) === String(trade.eodExitOrderId))
    || (trade.eodExitCorrelationId && order.correlationId === trade.eodExitCorrelationId));
}

function isTrackedSecurityOrder(order, trade) {
  return String(order.securityId || '') === String(trade.securityId || '');
}

function newCorrelationId() {
  return `sq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`.slice(0, 30);
}

function bestAsk(quote) {
  const depthAsk = Array.isArray(quote?.depth?.sell) ? quote.depth.sell[0]?.price : null;
  const ask = Number(quote?.top_ask_price ?? depthAsk);
  return Number.isFinite(ask) && ask > 0 ? ask : null;
}

function roundUpToTick(price, tickSize) {
  const tick = Number(tickSize) > 0 ? Number(tickSize) : 0.05;
  return Number((Math.ceil((Number(price) / tick) - 1e-9) * tick).toFixed(2));
}

async function reviewLiveSquareOff({
  trade,
  position,
  superOrders,
  regularOrders,
  optionQuote,
  now = new Date(),
  broker,
  save,
  notify
}) {
  const minute = indiaMinuteOfDay(now);
  if (!isSquareOffTime(now) || trade.status === 'CLOSED') return { action: 'NOT_DUE' };

  const liveQuantity = Number(position?.netQty || 0);
  const hasShortPosition = Number.isSafeInteger(liveQuantity) && liveQuantity < 0;
  const entryOrder = findTrackedSuperOrder(superOrders, trade);
  const entryStatus = statusOf(entryOrder);
  const today = indiaDate(now);
  const entryFromEarlierSession = trade.openedAt && indiaDate(new Date(trade.openedAt)) !== today;
  const exitFromEarlierSession = trade.eodExitDate && trade.eodExitDate !== today;
  const priorAlertTime = Date.parse(trade.eodSquareOffAlertedAt || '');
  const alertedEarlierSession = Number.isFinite(priorAlertTime)
    && indiaDate(new Date(priorAlertTime)) !== today;
  if (alertedEarlierSession) delete trade.eodSquareOffAlertedAt;
  if (exitFromEarlierSession && !findTrackedExitOrder(regularOrders, trade)) {
    delete trade.eodExitOrderId;
    delete trade.eodExitCorrelationId;
    delete trade.eodExitSubmittedAt;
    delete trade.eodExitOrderType;
    delete trade.eodExitCancelRequestedAt;
    trade.eodExitNextReviewAt = null;
    trade.eodExitDate = today;
  }
  const nextReviewAt = Date.parse(trade.eodExitNextReviewAt || '');
  const fallbackNeedsImmediateCancel = minute >= MARKET_FALLBACK_MINUTE
    && trade.eodExitOrderType === 'LIMIT'
    && !trade.eodExitCancelRequestedAt;
  if (Number.isFinite(nextReviewAt) && now.getTime() < nextReviewAt && !fallbackNeedsImmediateCancel) {
    return { action: 'WAITING' };
  }

  const scheduleReview = () => {
    trade.eodExitNextReviewAt = new Date(now.getTime() + REVIEW_INTERVAL_MS).toISOString();
  };
  const report = async (message, level = 'error') => {
    const shouldNotify = trade.eodExitLastError !== message;
    trade.eodExitLastError = message;
    scheduleReview();
    save();
    if (shouldNotify) await notify(level, message, { symbol: trade.symbol, securityId: trade.securityId });
  };

  if (entryOrder && ACTIVE_ORDER_STATUSES.has(entryStatus)) {
    try {
      await broker.cancelSuperOrderLeg(entryOrder.orderId, 'ENTRY_LEG');
      trade.eodEntryCancelRequestedAt = now.toISOString();
      scheduleReview();
      save();
      return { action: 'CANCELLED_PENDING_ENTRY' };
    } catch (error) {
      await report(`Could not cancel the pending entry order before square-off: ${error.message}`);
      return { action: 'ENTRY_CANCEL_FAILED' };
    }
  }
  if (!entryOrder && !entryFromEarlierSession) {
    await report('The bot-tracked Dhan entry order is missing from the broker order book; square-off is blocked until it can be reconciled.');
    return { action: 'ENTRY_ORDER_UNRECONCILED' };
  }

  if (!hasShortPosition) {
    if (liveQuantity > 0) {
      await report('The bot-tracked contract is no longer a short position; automatic square-off was stopped to avoid trading the wrong direction.');
      return { action: 'UNEXPECTED_POSITION_DIRECTION' };
    }
    trade.status = 'CLOSED';
    trade.closedAt = now.toISOString();
    trade.exitReason = 'END_OF_DAY';
    trade.eodExitNextReviewAt = null;
    delete trade.eodExitLastError;
    save();
    return { action: 'POSITION_ALREADY_FLAT' };
  }

  if (minute >= MARKET_CLOSE_MINUTE) {
    if (!trade.eodSquareOffAlertedAt) {
      trade.eodSquareOffAlertedAt = now.toISOString();
      trade.eodExitLastError = 'The bot-tracked Live position is still open at 15:30 IST. Automatic square-off retries have stopped; check Dhan immediately.';
      save();
      await notify('critical', trade.eodExitLastError, { symbol: trade.symbol, securityId: trade.securityId });
    }
    return { action: 'MARKET_CLOSED_WITH_OPEN_POSITION' };
  }

  const pendingProtectionLegs = (Array.isArray(entryOrder.legDetails) ? entryOrder.legDetails : [])
    .filter((leg) => ['TARGET_LEG', 'STOP_LOSS_LEG'].includes(leg.legName)
      && ACTIVE_LEG_STATUSES.has(statusOf(leg)));
  if (pendingProtectionLegs.length) {
    try {
      for (const leg of pendingProtectionLegs) {
        await broker.cancelSuperOrderLeg(entryOrder.orderId, leg.legName);
      }
      scheduleReview();
      save();
      return { action: 'CANCELLED_PROTECTIVE_LEGS' };
    } catch (error) {
      await report(`Could not cancel the active protective order legs before square-off: ${error.message}`);
      return { action: 'PROTECTION_CANCEL_FAILED' };
    }
  }

  const exitOrder = findTrackedExitOrder(regularOrders, trade);
  if (trade.eodExitCorrelationId && !exitOrder) {
    await report('The scheduled square-off order could not be found in Dhan yet; no duplicate order was submitted.');
    return { action: 'EXIT_ORDER_UNRECONCILED' };
  }
  if (exitOrder) {
    const exitStatus = statusOf(exitOrder);
    if (ACTIVE_ORDER_STATUSES.has(exitStatus)) {
      const marketFallback = minute >= MARKET_FALLBACK_MINUTE;
      const submittedAt = Date.parse(trade.eodExitSubmittedAt || '');
      const waitedLongEnough = Number.isFinite(submittedAt) && now.getTime() - submittedAt >= REVIEW_INTERVAL_MS;
      if (!marketFallback && !waitedLongEnough) {
        scheduleReview();
        save();
        return { action: 'EXIT_ORDER_PENDING' };
      }
      try {
        await broker.cancelRegularOrder(exitOrder.orderId);
        trade.eodExitCancelRequestedAt = now.toISOString();
        scheduleReview();
        save();
        return { action: 'CANCELLED_UNFILLED_EXIT' };
      } catch (error) {
        await report(`Could not cancel the unfilled square-off order; no replacement order was sent: ${error.message}`);
        return { action: 'EXIT_CANCEL_FAILED' };
      }
    }
    if (!TERMINAL_ORDER_STATUSES.has(exitStatus)) {
      await report(`Dhan returned an unrecognized square-off order status (${exitStatus || 'missing'}); no replacement order was sent.`);
      return { action: 'EXIT_STATUS_UNRECOGNIZED' };
    }
    if (exitStatus === 'TRADED' || exitStatus === 'CLOSED') {
      trade.eodExitNextReviewAt = new Date(now.getTime() + REVIEW_INTERVAL_MS).toISOString();
      save();
      return { action: 'RECONCILING_FILLED_EXIT' };
    }
    delete trade.eodExitOrderId;
    delete trade.eodExitCorrelationId;
    delete trade.eodExitSubmittedAt;
    delete trade.eodExitOrderType;
    delete trade.eodExitCancelRequestedAt;
  }

  const otherActiveOrder = regularOrders.find((order) =>
    isTrackedSecurityOrder(order, trade)
    && ACTIVE_ORDER_STATUSES.has(statusOf(order))
    && order.orderId !== trade.eodExitOrderId);
  if (otherActiveOrder) {
    await report('Another Dhan order is still active for this contract; square-off is waiting to avoid duplicate or competing orders.', 'warning');
    return { action: 'OTHER_ORDER_PENDING' };
  }

  const orderType = minute >= MARKET_FALLBACK_MINUTE ? 'MARKET' : 'LIMIT';
  let price = 0;
  if (orderType === 'LIMIT') {
    const ask = bestAsk(optionQuote);
    if (!ask) {
      await report('A valid option best-ask quote is unavailable; the scheduled LIMIT square-off was not submitted.');
      return { action: 'EXIT_QUOTE_UNAVAILABLE' };
    }
    price = roundUpToTick(ask, trade.tickSize);
  }

  const correlationId = newCorrelationId();
  const order = {
    dhanClientId: broker.clientId,
    correlationId,
    transactionType: 'BUY',
    exchangeSegment: 'NSE_FNO',
    productType: 'INTRADAY',
    orderType,
    validity: 'DAY',
    securityId: String(trade.securityId),
    quantity: Math.abs(liveQuantity),
    price,
    triggerPrice: 0
  };
  trade.eodExitCorrelationId = correlationId;
  trade.eodExitSubmittedAt = now.toISOString();
  trade.eodExitOrderType = orderType;
  trade.eodExitDate = today;
  trade.eodExitCancelRequestedAt = null;
  trade.eodExitQuantity = order.quantity;
  scheduleReview();
  save();
  try {
    const response = await broker.placeRegularOrder(order);
    const data = response.data || response;
    trade.eodExitOrderId = data.orderId || data.order_id || null;
    delete trade.eodExitLastError;
    save();
    return { action: `SUBMITTED_${orderType}`, orderId: trade.eodExitOrderId };
  } catch (error) {
    trade.eodExitLastError = `Square-off order submission is uncertain: ${error.message}. No retry will occur until Dhan's order book reconciles correlation ${correlationId}.`;
    save();
    await notify('critical', trade.eodExitLastError, { symbol: trade.symbol, securityId: trade.securityId });
    return { action: 'EXIT_SUBMISSION_UNCERTAIN', correlationId };
  }
}

module.exports = {
  REVIEW_INTERVAL_MS,
  MARKET_FALLBACK_MINUTE,
  MARKET_CLOSE_MINUTE,
  findTrackedSuperOrder,
  findTrackedExitOrder,
  bestAsk,
  roundUpToTick,
  reviewLiveSquareOff
};
