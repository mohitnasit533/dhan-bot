'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculatePreviousDayCpr,
  confirmedSignal,
  getGapDownSetup,
  optionTargetForSignal,
  calculateShortOptionRisk,
  chooseOptionExpiry,
  rankLiquidInstruments,
  meetsOptionLiquidity,
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

function intradayCandle(date, minute, open, high, low, close) {
  return {
    timestamp: Math.floor(new Date(`${date}T09:15:00+05:30`).getTime() / 1000) + minute * 60,
    open,
    high,
    low,
    close,
    volume: 1000
  };
}

function gapDownCandles(openingClose, confirmationClose) {
  const candles = Array.from({ length: 40 }, (_, index) =>
    intradayCandle('2026-10-20', index * 15, 100, 100, 100, 100));
  candles.push(intradayCandle('2026-10-21', 0, 97, 100, 96, openingClose));
  if (confirmationClose !== undefined) {
    candles.push(intradayCandle('2026-10-21', 15, openingClose, 100.2, 96, confirmationClose));
  }
  return candles;
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

test('sells puts at positive-signal delta -0.40 and calls at negative-signal delta +0.40', () => {
  assert.deepEqual(optionTargetForSignal('BUY'), { option: 'pe', delta: -0.4 });
  assert.deepEqual(optionTargetForSignal('SELL'), { option: 'ce', delta: 0.4 });
  assert.throws(() => optionTargetForSignal('WATCH'), /confirmed BUY or SELL/);
});

test('gap-down setup waits for the EMA band candle then confirms above or below EMA 21', () => {
  const wait = getGapDownSetup(gapDownCandles(97, undefined), new Date('2026-10-21T06:00:00Z'));
  const bullishBreak = getGapDownSetup(gapDownCandles(100, 100.2), new Date('2026-10-21T06:00:00Z'));
  const bearishBreak = getGapDownSetup(gapDownCandles(100, 99.8), new Date('2026-10-21T06:00:00Z'));

  assert.equal(wait.status, 'WAITING_FOR_EMA_BAND');
  assert.equal(bullishBreak.status, 'CONFIRMED');
  assert.equal(bullishBreak.signal, 'BUY');
  assert.equal(bearishBreak.status, 'CONFIRMED');
  assert.equal(bearishBreak.signal, 'SELL');
});

test('gap-down setup requires a 3% opening gap below the previous close', () => {
  const belowThreshold = gapDownCandles(97, undefined);
  belowThreshold[40].open = 98;

  assert.deepEqual(
    getGapDownSetup(belowThreshold, new Date('2026-10-21T06:00:00Z')),
    { active: false, status: 'NO_GAP', signal: 'WATCH' }
  );
});

test('a gap-down break signal only fires on the first confirmation candle', () => {
  const candles = gapDownCandles(100, 100.2);
  candles.push(intradayCandle('2026-10-21', 30, 100.2, 100.3, 100.1, 100.25));

  const setup = getGapDownSetup(candles, new Date('2026-10-21T06:00:00Z'));
  assert.equal(setup.status, 'SETUP_EXPIRED');
  assert.equal(setup.signal, 'WATCH');
});

test('calculates short-option stop and target from configured INR risk', () => {
  assert.deepEqual(calculateShortOptionRisk(100, 0.05, 10, 200, 500), {
    stopLossPrice: 120,
    targetPrice: 50
  });
  assert.throws(() => calculateShortOptionRisk(100, 0.05, 10, null, 500), /Configure positive stop loss/);
});

test('keeps every NSE F&O underlying and ranks available quotes by turnover', () => {
  const instruments = [
    { symbol: 'LOW', securityId: '1' },
    { symbol: 'HIGH', securityId: '2' },
    { symbol: 'EDGE', securityId: '3' },
    { symbol: 'NO_QUOTE', securityId: '4' }
  ];
  const quotes = {
    NSE_EQ: {
      1: { volume: 1000000, average_price: 20 },
      2: { volume: 1000000, average_price: 100 },
      3: { volume: 500000, average_price: 100 }
    }
  };
  const ranked = rankLiquidInstruments(instruments, quotes);

  assert.deepEqual(ranked.map((row) => row.symbol), ['HIGH', 'EDGE', 'LOW', 'NO_QUOTE']);
  assert.deepEqual(ranked.map((row) => row.turnover), [100000000, 50000000, 20000000, 0]);
  assert.deepEqual(rankLiquidInstruments(instruments, quotes, 50000000).map((row) => row.symbol), ['HIGH', 'EDGE']);
});

test('rejects missing option OI or invalid bid/ask data instead of coercing null to zero', () => {
  const settings = { minOpenInterest: 1000, maxSpreadPct: 2 };
  assert.equal(meetsOptionLiquidity({ oi: 1000, top_bid_price: 10, top_ask_price: 10 }, { minOpenInterest: null, maxSpreadPct: 0 }), false);
  assert.equal(meetsOptionLiquidity({ oi: null, top_bid_price: 10, top_ask_price: 10.1 }, settings), false);
  assert.equal(meetsOptionLiquidity({ oi: 1000, top_bid_price: 0, top_ask_price: 10 }, settings), false);
  assert.equal(meetsOptionLiquidity({ oi: 1000, top_bid_price: 10, top_ask_price: 10.1 }, settings), true);
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
