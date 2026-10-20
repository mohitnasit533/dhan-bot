'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculatePreviousDayCpr,
  confirmedSignal,
  getOpeningGapSetup,
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

function openingGapCandles(openingPrice, todayCloses) {
  const candles = Array.from({ length: 40 }, (_, index) =>
    intradayCandle('2026-10-20', index * 15, 100, 100, 100, 100));
  todayCloses.forEach((close, index) => candles.push(intradayCandle(
    '2026-10-21',
    index * 15,
    index === 0 ? openingPrice : todayCloses[index - 1],
    Math.max(openingPrice, close, 100),
    Math.min(openingPrice, close, 96),
    close
  )));
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

test('gap-down waits for EMA band, then an above-EMA close, then a return below EMA 21 to confirm SELL CALL', () => {
  const date = new Date('2026-10-21T06:00:00Z');
  const waitingForBand = getOpeningGapSetup(openingGapCandles(97, [97]), date);
  const waitingForAbove = getOpeningGapSetup(openingGapCandles(97, [97, 99.8]), date);
  const aboveDoesNotTrade = getOpeningGapSetup(openingGapCandles(97, [97, 99.8, 100]), date);
  const returnBelow = getOpeningGapSetup(openingGapCandles(97, [97, 99.8, 100, 99]), date);

  assert.equal(waitingForBand.status, 'WAITING_FOR_EMA_BAND');
  assert.equal(waitingForAbove.status, 'WAITING_FOR_EMA21_BREAK');
  assert.equal(aboveDoesNotTrade.status, 'WAITING_FOR_RETURN_BELOW_EMA21');
  assert.equal(aboveDoesNotTrade.signal, 'WATCH');
  assert.equal(returnBelow.status, 'CONFIRMED');
  assert.equal(returnBelow.signal, 'SELL');
  assert.equal(returnBelow.direction, 'DOWN');
});

test('gap-up waits for an EMA-band candle then confirms BUY / SELL PUT above EMA 21', () => {
  const date = new Date('2026-10-21T06:00:00Z');
  const waitingForBand = getOpeningGapSetup(openingGapCandles(103, [103]), date);
  const waitingForAbove = getOpeningGapSetup(openingGapCandles(103, [103, 100.2]), date);
  const confirmed = getOpeningGapSetup(openingGapCandles(103, [103, 100.2, 100.3]), date);

  assert.equal(waitingForBand.status, 'WAITING_FOR_EMA_BAND');
  assert.equal(waitingForAbove.status, 'WAITING_FOR_EMA21_BREAK');
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(confirmed.signal, 'BUY');
  assert.equal(confirmed.direction, 'UP');
});

test('opening-gap setup requires a 3% gap in either direction', () => {
  const date = new Date('2026-10-21T06:00:00Z');
  const belowThreshold = openingGapCandles(97.01, [97]);
  const gapUpBelowThreshold = openingGapCandles(102.99, [103]);
  assert.deepEqual(
    getOpeningGapSetup(belowThreshold, date),
    { active: false, status: 'NO_GAP', signal: 'WATCH' }
  );
  assert.deepEqual(
    getOpeningGapSetup(gapUpBelowThreshold, date),
    { active: false, status: 'NO_GAP', signal: 'WATCH' }
  );
});

test('opening-gap confirmation only fires on the current last candle', () => {
  const candles = openingGapCandles(103, [103, 100.2, 100.3, 100.4]);

  const setup = getOpeningGapSetup(candles, new Date('2026-10-21T06:00:00Z'));
  assert.equal(setup.status, 'SETUP_EXPIRED');
  assert.equal(setup.signal, 'WATCH');
});

test('calculates short-option stop and target from rupee risk or percentage of premium', () => {
  assert.deepEqual(calculateShortOptionRisk(100, 0.05, 10, 200, 500, 'INR'), {
    stopLossPrice: 120,
    targetPrice: 50
  });
  assert.deepEqual(calculateShortOptionRisk(100, 0.05, 10, 20, 50, 'PERCENT'), {
    stopLossPrice: 120,
    targetPrice: 50
  });
  assert.deepEqual(calculateShortOptionRisk(100, 0.05, 10, 0, 0, 'PERCENT'), {
    stopLossPrice: 0,
    targetPrice: 0
  });
  assert.throws(() => calculateShortOptionRisk(100, 0.05, 10, -1, 50), /valid non-negative value/);
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
