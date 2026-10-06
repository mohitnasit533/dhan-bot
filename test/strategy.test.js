'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculatePreviousDayCpr,
  confirmedSignal,
  calculateShortOptionRisk,
  chooseOptionExpiry,
  istDate
} = require('../dhan');

function candle(date, high, low, close) {
  return {
    timestamp: Math.floor(new Date(`${date}T10:00:00+05:30`).getTime() / 1000),
    high,
    low,
    close
  };
}

test('calculates narrow CPR from the previous trading session', () => {
  const cpr = calculatePreviousDayCpr([
    candle('2026-10-05', 101, 99, 100),
    candle('2026-10-06', 100.2, 99.8, 100)
  ]);

  assert.equal(cpr.narrow, true);
  assert.ok(cpr.widthPct <= 0.5);
  assert.equal(cpr.previousClose, 100);
  assert.ok(cpr.top >= cpr.bottom);
});

test('requires all bullish confirmation conditions', () => {
  const base = {
    crossedUp: true,
    crossedDown: false,
    trend: 'UP',
    close: 102,
    vwap: 101,
    cpr: { narrow: true, top: 101.5, bottom: 100.5 }
  };

  assert.equal(confirmedSignal(base), 'BUY');
  assert.equal(confirmedSignal({ ...base, cpr: { ...base.cpr, narrow: false } }), 'WATCH');
  assert.equal(confirmedSignal({ ...base, close: 101 }), 'WATCH');
  assert.equal(confirmedSignal({ ...base, trend: 'DOWN' }), 'WATCH');
  assert.equal(confirmedSignal({ ...base, vwap: null }), 'WATCH');
});

test('requires all bearish confirmation conditions', () => {
  assert.equal(confirmedSignal({
    crossedUp: false,
    crossedDown: true,
    trend: 'DOWN',
    close: 99,
    vwap: 100,
    cpr: { narrow: true, top: 101, bottom: 99.5 }
  }), 'SELL');
});

test('calculates fixed 20% stop loss and 50% target for short option premium', () => {
  assert.deepEqual(calculateShortOptionRisk(100, 0.05), {
    stopLossPrice: 120,
    targetPrice: 50
  });
});

test('uses the next calendar-month stock option expiry during expiry week', () => {
  assert.equal(chooseOptionExpiry([
    '2026-10-08',
    '2026-10-29',
    '2026-11-26'
  ], new Date('2026-10-25T04:00:00Z')), '2026-11-26');
});

test('rolls to the next monthly expiry exactly seven days before monthly expiry', () => {
  assert.equal(chooseOptionExpiry([
    '2026-10-08',
    '2026-10-29',
    '2026-11-26'
  ], new Date('2026-10-22T04:00:00Z')), '2026-11-26');
});

test('uses the current monthly expiry outside its final seven days', () => {
  assert.equal(chooseOptionExpiry([
    '2026-10-29',
    '2026-11-26'
  ], new Date('2026-10-05T04:00:00Z')), '2026-10-29');
});

test('formats historical candle dates as Dhan API YYYY-MM-DD in India time', () => {
  assert.equal(istDate(new Date('2026-10-06T20:00:00Z')), '2026-10-07');
});
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculatePreviousDayCpr,
  confirmedSignal,
  calculateShortOptionRisk,
  chooseOptionExpiry,
  istDate
} = require('../dhan');

function candle(date, high, low, close) {
  return {
    timestamp: Math.floor(new Date(`${date}T10:00:00+05:30`).getTime() / 1000),
    high,
    low,
    close
  };
}

test('calculates narrow CPR from the previous trading session', () => {
  const cpr = calculatePreviousDayCpr([
    candle('2026-10-05', 101, 99, 100),
    candle('2026-10-06', 100.2, 99.8, 100)
  ]);

  assert.equal(cpr.narrow, true);
  assert.ok(cpr.widthPct <= 0.5);
  assert.equal(cpr.previousClose, 100);
  assert.ok(cpr.top >= cpr.bottom);
});

test('requires all bullish confirmation conditions', () => {
  const base = {
    crossedUp: true,
    crossedDown: false,
    trend: 'UP',
    close: 102,
    vwap: 101,
    cpr: { narrow: true, top: 101.5, bottom: 100.5 }
  };

  assert.equal(confirmedSignal(base), 'BUY');
  assert.equal(confirmedSignal({ ...base, cpr: { ...base.cpr, narrow: false } }), 'WATCH');
  assert.equal(confirmedSignal({ ...base, close: 101 }), 'WATCH');
  assert.equal(confirmedSignal({ ...base, trend: 'DOWN' }), 'WATCH');
  assert.equal(confirmedSignal({ ...base, vwap: null }), 'WATCH');
});

test('requires all bearish confirmation conditions', () => {
  assert.equal(confirmedSignal({
    crossedUp: false,
    crossedDown: true,
    trend: 'DOWN',
    close: 99,
    vwap: 100,
    cpr: { narrow: true, top: 101, bottom: 99.5 }
  }), 'SELL');
});

test('calculates fixed 20% stop loss and 50% target for short option premium', () => {
  assert.deepEqual(calculateShortOptionRisk(100, 0.05), {
    stopLossPrice: 120,
    targetPrice: 50
  });
});

test('uses the next calendar-month stock option expiry during expiry week', () => {
  assert.equal(chooseOptionExpiry([
    '2026-10-08',
    '2026-10-29',
    '2026-11-26'
  ], new Date('2026-10-05T04:00:00Z')), '2026-11-26');
});

test('uses the nearest expiry outside the final seven days', () => {
  assert.equal(chooseOptionExpiry([
    '2026-10-29',
    '2026-11-26'
  ], new Date('2026-10-05T04:00:00Z')), '2026-10-29');
});

test('formats historical candle dates as Dhan API YYYY-MM-DD in India time', () => {
  assert.equal(istDate(new Date('2026-10-06T20:00:00Z')), '2026-10-07');
});
