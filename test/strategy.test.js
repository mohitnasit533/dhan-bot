'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculatePreviousDayCpr,
  confirmedSignal,
  calculateShortOptionRisk,
  chooseOptionExpiry,
  deriveFnoEquityInstruments,
  istDate,
  isEntryWindowOpen
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

test('ranks NSE F&O stocks by turnover and excludes below-threshold stocks', () => {
  const ranked = rankLiquidInstruments([
    { symbol: 'LOW', securityId: '1' },
    { symbol: 'HIGH', securityId: '2' },
    { symbol: 'EDGE', securityId: '3' },
    { symbol: 'NO_QUOTE', securityId: '4' }
  ], {
    NSE_EQ: {
      1: { volume: 1000000, average_price: 20 },
      2: { volume: 1000000, average_price: 100 },
      3: { volume: 500000, average_price: 100 }
    }
  });

  assert.deepEqual(ranked.map((row) => row.symbol), ['HIGH', 'EDGE']);
  assert.deepEqual(ranked.map((row) => row.turnover), [100000000, 50000000]);
});

test('uses the next calendar-month stock option expiry during expiry week', () => {
  assert.equal(chooseOptionExpiry([
    '2026-10-08',
    '2026-10-29',
    '2026-11-05',
    '2026-11-26'
  ], new Date('2026-10-26T04:00:00Z')), '2026-11-26');
});

test('uses the current monthly expiry outside its final seven calendar days', () => {
  assert.equal(chooseOptionExpiry([
    '2026-10-08',
    '2026-10-29',
    '2026-11-26'
  ], new Date('2026-10-05T04:00:00Z')), '2026-10-29');
});

test('entry window starts at 09:45 and stops at 14:00 India time', () => {
  assert.equal(isEntryWindowOpen(new Date('2026-10-05T04:14:00Z')), false);
  assert.equal(isEntryWindowOpen(new Date('2026-10-05T04:15:00Z')), true);
  assert.equal(isEntryWindowOpen(new Date('2026-10-05T08:29:00Z')), true);
  assert.equal(isEntryWindowOpen(new Date('2026-10-05T08:30:00Z')), false);
  assert.equal(isEntryWindowOpen(new Date('2026-10-03T04:15:00Z')), false);
});

test('formats historical candle dates as Dhan API YYYY-MM-DD in India time', () => {
  assert.equal(istDate(new Date('2026-10-06T20:00:00Z')), '2026-10-07');
});

test('derives the current stock F&O universe from NSE stock-option contracts', () => {
  const instruments = deriveFnoEquityInstruments([
    { SEM_EXM_EXCH_ID: 'NSE', SEM_INSTRUMENT_NAME: 'EQUITY', SEM_TRADING_SYMBOL: 'RELIANCE', SEM_SMST_SECURITY_ID: '2885' },
    { SEM_EXM_EXCH_ID: 'NSE', SEM_INSTRUMENT_NAME: 'EQUITY', SEM_TRADING_SYMBOL: 'TCS', SEM_SMST_SECURITY_ID: '11536' },
    { SEM_EXM_EXCH_ID: 'NSE', SEM_INSTRUMENT_NAME: 'EQUITY', SEM_TRADING_SYMBOL: 'CASHONLY', SEM_SMST_SECURITY_ID: '9999' },
    { SEM_EXM_EXCH_ID: 'NSE', SEM_INSTRUMENT_NAME: 'OPTSTK', SEM_EXPIRY_DATE: '2026-10-29', SM_SYMBOL_NAME: 'RELIANCE' },
    { SEM_EXM_EXCH_ID: 'NSE', SEM_INSTRUMENT_NAME: 'OPTSTK', SEM_EXPIRY_DATE: '2026-10-29', SM_SYMBOL_NAME: 'TCS' },
    { SEM_EXM_EXCH_ID: 'NSE', SEM_INSTRUMENT_NAME: 'OPTSTK', SEM_EXPIRY_DATE: '2026-09-24', SM_SYMBOL_NAME: 'CASHONLY' },
    { SEM_EXM_EXCH_ID: 'NSE', SEM_INSTRUMENT_NAME: 'OPTIDX', SEM_EXPIRY_DATE: '2026-10-29', SM_SYMBOL_NAME: 'NIFTY' }
  ], '2026-10-20');

  assert.deepEqual(instruments, [
    { symbol: 'RELIANCE', securityId: '2885' },
    { symbol: 'TCS', securityId: '11536' }
  ]);
});
