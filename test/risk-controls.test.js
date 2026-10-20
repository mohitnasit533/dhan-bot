'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SETTINGS,
  validateTradeSettings,
  missingRiskSettings,
  calculatePaperDailyPnl,
  calculateBotLiveDailyPnl,
  isSquareOffTime,
  indiaMinuteOfDay
} = require('../risk-controls');

test('zero risk amounts disable price triggers without blocking trading readiness', () => {
  const settings = validateTradeSettings({
    ...DEFAULT_SETTINGS,
    riskUnit: 'PERCENT',
    stopLossValue: 0,
    targetValue: 0
  });
  assert.equal(settings.stopLossValue, 0);
  assert.equal(settings.targetValue, 0);
  assert.deepEqual(missingRiskSettings(settings), []);
});

test('validates rupee and percentage exit controls', () => {
  assert.deepEqual(validateTradeSettings({
    ...DEFAULT_SETTINGS,
    riskUnit: 'INR',
    stopLossValue: 500,
    targetValue: 1000
  }), {
    ...DEFAULT_SETTINGS,
    riskUnit: 'INR',
    stopLossValue: 500,
    targetValue: 1000
  });
  assert.equal(validateTradeSettings({
    ...DEFAULT_SETTINGS,
    riskUnit: 'PERCENT',
    stopLossValue: 20,
    targetValue: 50
  }).targetValue, 50);
});

test('migrates saved legacy INR risk settings without requiring daily max loss', () => {
  const settings = validateTradeSettings({
    lotSize: 2,
    maxTrades: 3,
    stopLossInr: 200,
    targetInr: 300,
    maxDailyLossInr: 1000,
    minOpenInterest: 1000,
    maxSpreadPct: 2
  });
  assert.equal(settings.riskUnit, 'INR');
  assert.equal(settings.stopLossValue, 200);
  assert.equal(settings.targetValue, 300);
  assert.equal(Object.hasOwn(settings, 'maxDailyLossInr'), false);
});

test('rejects negative risk values, impossible percentage targets, and invalid liquidity filters', () => {
  for (const [field, value] of [
    ['stopLossValue', -1],
    ['targetValue', 'not a number'],
    ['targetValue', 100],
    ['minOpenInterest', 0],
    ['maxSpreadPct', 101]
  ]) {
    assert.throws(() => validateTradeSettings({
      ...DEFAULT_SETTINGS,
      riskUnit: field === 'targetValue' && value === 100 ? 'PERCENT' : 'INR',
      [field]: value
    }));
  }
});

test('schedules square-off at 14:58 India time on weekdays only', () => {
  assert.equal(isSquareOffTime(new Date('2026-10-20T09:27:00Z')), false);
  assert.equal(isSquareOffTime(new Date('2026-10-20T09:28:00Z')), true);
  assert.equal(isSquareOffTime(new Date('2026-10-24T09:28:00Z')), false);
  assert.equal(indiaMinuteOfDay(new Date('2026-10-20T09:29:00Z')), 14 * 60 + 59);
});

test('paper daily P&L combines current open and same-day closed positions', () => {
  const now = new Date('2026-10-20T10:00:00+05:30');
  const pnl = calculatePaperDailyPnl(
    [{ openedAt: '2026-10-20T09:00:00+05:30', entryPrice: 100, currentPrice: 90, quantity: 10 }],
    [{ closedAt: '2026-10-20T09:30:00+05:30', pnlInr: -25 }],
    now
  );
  assert.equal(pnl, 75);
});

test('live daily P&L uses bot-tracked security IDs and avoids counting the same contract twice', () => {
  const now = new Date('2026-10-20T10:00:00+05:30');
  const trades = [
    { securityId: '123', openedAt: '2026-10-20T09:00:00+05:30', lastPnlInr: 0 },
    { securityId: '123', openedAt: '2026-10-20T09:30:00+05:30', lastPnlInr: 0 },
    { securityId: '456', openedAt: '2026-10-20T09:00:00+05:30', lastPnlInr: 15 }
  ];
  const positions = [
    { securityId: '123', realizedProfit: -10, unrealizedProfit: -20 },
    { securityId: '999', realizedProfit: -500, unrealizedProfit: 0 }
  ];
  assert.equal(calculateBotLiveDailyPnl(trades, positions, now), -15);
});
