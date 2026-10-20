'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SETTINGS,
  validateTradeSettings,
  missingRiskSettings,
  calculatePaperDailyPnl,
  calculateBotLiveDailyPnl,
  dailyLossReached
} = require('../risk-controls');

test('blank risk amounts remain unset and prevent trading readiness', () => {
  const settings = validateTradeSettings({
    ...DEFAULT_SETTINGS,
    maxDailyLossInr: '',
    stopLossInr: null,
    targetInr: ''
  });
  assert.equal(settings.maxDailyLossInr, null);
  assert.ok(missingRiskSettings(settings).includes('Stop loss (INR per position)'));
  assert.ok(missingRiskSettings(settings).includes('Profit target (INR per position)'));
  assert.equal(dailyLossReached(-5000, null), false);
  assert.equal(dailyLossReached(-5000, 5000), true);
});

test('rejects invalid optional INR controls and liquidity thresholds', () => {
  for (const [field, value] of [
    ['stopLossInr', 0],
    ['targetInr', -1],
    ['maxDailyLossInr', 'not a number'],
    ['minOpenInterest', 0],
    ['maxSpreadPct', 101]
  ]) {
    assert.throws(() => validateTradeSettings({ ...DEFAULT_SETTINGS, [field]: value }));
  }
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
