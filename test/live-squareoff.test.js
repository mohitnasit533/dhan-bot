'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewLiveSquareOff, roundUpToTick } = require('../live-squareoff');

const at1458 = new Date('2026-10-20T09:28:00.000Z');

function createTrade(overrides = {}) {
  return {
    symbol: 'RELIANCE',
    securityId: '12345',
    tickSize: 0.05,
    entryPrice: 100,
    quantity: 10,
    openedAt: '2026-10-20T09:00:00.000Z',
    correlationId: 'entry-correlation',
    orderId: 'entry-order',
    status: 'SUBMITTED',
    ...overrides
  };
}

function createBroker(overrides = {}) {
  const calls = { cancelSuper: [], cancelRegular: [], placed: [] };
  return {
    calls,
    clientId: '12345678',
    async cancelSuperOrderLeg(...args) { calls.cancelSuper.push(args); return {}; },
    async cancelRegularOrder(...args) { calls.cancelRegular.push(args); return {}; },
    async placeRegularOrder(order) { calls.placed.push(order); return { data: { orderId: `close-${calls.placed.length}` } }; },
    ...overrides
  };
}

function saveMock() {
  let count = 0;
  return { save: () => { count += 1; }, count: () => count };
}

const entryOrder = {
  orderId: 'entry-order',
  correlationId: 'entry-correlation',
  orderStatus: 'TRADED',
  legDetails: []
};

test('submits a bot-tracked LIMIT square-off at the rounded best ask', async () => {
  const trade = createTrade();
  const broker = createBroker();
  const state = saveMock();
  const result = await reviewLiveSquareOff({
    trade,
    position: { securityId: '12345', netQty: -10 },
    superOrders: [entryOrder],
    regularOrders: [],
    optionQuote: { top_ask_price: 100.02 },
    now: at1458,
    broker,
    save: state.save,
    notify: async () => {}
  });

  assert.equal(result.action, 'SUBMITTED_LIMIT');
  assert.equal(broker.calls.placed.length, 1);
  assert.equal(broker.calls.placed[0].transactionType, 'BUY');
  assert.equal(broker.calls.placed[0].orderType, 'LIMIT');
  assert.equal(broker.calls.placed[0].price, 100.05);
  assert.equal(broker.calls.placed[0].quantity, 10);
  assert.equal(trade.eodExitOrderId, 'close-1');
  assert.ok(state.count() >= 2);
});

test('cancels an unfilled LIMIT before replacement and never duplicates while active', async () => {
  const trade = createTrade({
    eodExitCorrelationId: 'exit-correlation',
    eodExitOrderId: 'exit-order',
    eodExitSubmittedAt: new Date(at1458.getTime() - 10_000).toISOString(),
    eodExitOrderType: 'LIMIT'
  });
  const broker = createBroker();
  const result = await reviewLiveSquareOff({
    trade,
    position: { securityId: '12345', netQty: -10 },
    superOrders: [entryOrder],
    regularOrders: [{
      orderId: 'exit-order',
      correlationId: 'exit-correlation',
      securityId: '12345',
      orderStatus: 'PENDING'
    }],
    optionQuote: { top_ask_price: 100 },
    now: at1458,
    broker,
    save: () => {},
    notify: async () => {}
  });
  assert.equal(result.action, 'CANCELLED_UNFILLED_EXIT');
  assert.deepEqual(broker.calls.cancelRegular, [['exit-order']]);
  assert.equal(broker.calls.placed.length, 0);
});

test('starts MARKET fallback at 14:59 even if the LIMIT has been resting for less than ten seconds', async () => {
  const at1459 = new Date('2026-10-20T09:29:00.000Z');
  const trade = createTrade({
    eodExitCorrelationId: 'exit-correlation',
    eodExitOrderId: 'exit-order',
    eodExitSubmittedAt: new Date(at1459.getTime() - 1000).toISOString(),
    eodExitOrderType: 'LIMIT',
    eodExitNextReviewAt: new Date(at1459.getTime() + 9000).toISOString()
  });
  const broker = createBroker();
  const result = await reviewLiveSquareOff({
    trade,
    position: { securityId: '12345', netQty: -10 },
    superOrders: [entryOrder],
    regularOrders: [{
      orderId: 'exit-order',
      correlationId: 'exit-correlation',
      securityId: '12345',
      orderStatus: 'PENDING'
    }],
    now: at1459,
    broker,
    save: () => {},
    notify: async () => {}
  });
  assert.equal(result.action, 'CANCELLED_UNFILLED_EXIT');
  assert.deepEqual(broker.calls.cancelRegular, [['exit-order']]);
  assert.equal(broker.calls.placed.length, 0);
});

test('uses MARKET only after the previous LIMIT is confirmed cancelled', async () => {
  const at1459 = new Date('2026-10-20T09:29:10.000Z');
  const trade = createTrade({
    eodExitCorrelationId: 'exit-correlation',
    eodExitOrderId: 'exit-order',
    eodExitSubmittedAt: new Date(at1459.getTime() - 11_000).toISOString(),
    eodExitOrderType: 'LIMIT',
    eodExitNextReviewAt: at1459.toISOString(),
    eodExitCancelRequestedAt: new Date(at1459.getTime() - 10_000).toISOString()
  });
  const broker = createBroker();
  const result = await reviewLiveSquareOff({
    trade,
    position: { securityId: '12345', netQty: -7 },
    superOrders: [entryOrder],
    regularOrders: [{
      orderId: 'exit-order',
      correlationId: 'exit-correlation',
      securityId: '12345',
      orderStatus: 'CANCELLED'
    }],
    now: at1459,
    broker,
    save: () => {},
    notify: async () => {}
  });
  assert.equal(result.action, 'SUBMITTED_MARKET');
  assert.equal(broker.calls.placed[0].orderType, 'MARKET');
  assert.equal(broker.calls.placed[0].price, 0);
  assert.equal(broker.calls.placed[0].quantity, 7);
});

test('cancels active protective legs and waits for broker reconciliation before square-off', async () => {
  const broker = createBroker();
  const result = await reviewLiveSquareOff({
    trade: createTrade(),
    position: { securityId: '12345', netQty: -10 },
    superOrders: [{
      ...entryOrder,
      legDetails: [
        { legName: 'TARGET_LEG', orderStatus: 'PENDING' },
        { legName: 'STOP_LOSS_LEG', orderStatus: 'PENDING' }
      ]
    }],
    regularOrders: [],
    optionQuote: { top_ask_price: 100 },
    now: at1458,
    broker,
    save: () => {},
    notify: async () => {}
  });
  assert.equal(result.action, 'CANCELLED_PROTECTIVE_LEGS');
  assert.deepEqual(broker.calls.cancelSuper, [
    ['entry-order', 'TARGET_LEG'],
    ['entry-order', 'STOP_LOSS_LEG']
  ]);
  assert.equal(broker.calls.placed.length, 0);
});

test('does not submit a duplicate when the previous close correlation is not yet in the order book', async () => {
  const broker = createBroker();
  const alerts = [];
  const result = await reviewLiveSquareOff({
    trade: createTrade({ eodExitCorrelationId: 'uncertain-correlation' }),
    position: { securityId: '12345', netQty: -10 },
    superOrders: [entryOrder],
    regularOrders: [],
    optionQuote: { top_ask_price: 100 },
    now: at1458,
    broker,
    save: () => {},
    notify: async (...args) => alerts.push(args)
  });
  assert.equal(result.action, 'EXIT_ORDER_UNRECONCILED');
  assert.equal(broker.calls.placed.length, 0);
  assert.equal(alerts.length, 1);
});

test('does not send any order after market close and alerts once for the open position', async () => {
  const at1530 = new Date('2026-10-20T10:00:00.000Z');
  const trade = createTrade();
  const broker = createBroker();
  const alerts = [];
  const options = {
    trade,
    position: { securityId: '12345', netQty: -10 },
    superOrders: [entryOrder],
    regularOrders: [],
    optionQuote: { top_ask_price: 100 },
    now: at1530,
    broker,
    save: () => {},
    notify: async (...args) => alerts.push(args)
  };
  assert.equal((await reviewLiveSquareOff(options)).action, 'MARKET_CLOSED_WITH_OPEN_POSITION');
  assert.equal((await reviewLiveSquareOff(options)).action, 'MARKET_CLOSED_WITH_OPEN_POSITION');
  assert.equal(broker.calls.placed.length, 0);
  assert.equal(alerts.length, 1);
});

test('records a tracked position as flat without placing an order', async () => {
  const trade = createTrade();
  const broker = createBroker();
  const result = await reviewLiveSquareOff({
    trade,
    position: { securityId: '12345', netQty: 0 },
    superOrders: [entryOrder],
    regularOrders: [],
    now: at1458,
    broker,
    save: () => {},
    notify: async () => {}
  });
  assert.equal(result.action, 'POSITION_ALREADY_FLAT');
  assert.equal(trade.status, 'CLOSED');
  assert.equal(broker.calls.placed.length, 0);
});

test('rounds a buy-to-close limit upward to the contract tick', () => {
  assert.equal(roundUpToTick(100.02, 0.05), 100.05);
  assert.equal(roundUpToTick(100.1, 0.05), 100.1);
});
