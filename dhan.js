'use strict';

const { parse } = require('csv-parse/sync');

const API_BASE = 'https://api.dhan.co/v2';
const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const SCAN_SYMBOLS = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'SBIN', 'ICICIBANK', 'LTIM', 'TECHM', 'BAJFINANCE', 'AXISBANK'];

let credentials = null;
let scripMasterPromise = null;
let quoteCache = { fetchedAt: 0, quotes: null, key: '' };
let lastCandleRequestAt = 0;
let lastOptionChainAt = 0;
let lastQuoteRequestAt = 0;
let quoteQueue = Promise.resolve();
const candleCache = new Map();

function safeErrorMessage(payload, fallback) {
  return payload?.errorMessage || payload?.remarks?.error_message || payload?.message || fallback;
}

async function requestDhan(path, options = {}, token = credentials?.accessToken) {
  if (!token) throw new Error('Connect a Dhan account first.');

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    signal: AbortSignal.timeout(15000),
    headers: {
      'access-token': token,
      ...(credentials?.clientId ? { 'client-id': credentials.clientId } : {}),
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.status === 'failure') {
    const error = new Error(safeErrorMessage(payload, `Dhan API request failed (${response.status}).`));
    error.statusCode = response.status;
    throw error;
  }

  return payload;
}

async function connect(clientId, accessToken) {
  if (typeof clientId !== 'string' || !/^\d{6,12}$/.test(clientId.trim())) {
    throw new Error('Enter the Dhan Client ID shown in your Dhan profile.');
  }
  if (typeof accessToken !== 'string' || accessToken.trim().length < 20 || accessToken.length > 4096) {
    throw new Error('Enter a valid Dhan access token.');
  }

  const normalizedClientId = clientId.trim();
  const normalizedToken = accessToken.trim();
  const result = await requestDhan('/profile', {
    headers: { 'client-id': normalizedClientId }
  }, normalizedToken);
  const profile = result.data || result;
  const profileClientId = String(profile.dhanClientId || profile.clientId || '').trim();

  if (profileClientId && profileClientId !== normalizedClientId) {
    throw new Error('The token belongs to a different Dhan Client ID.');
  }

  credentials = { clientId: normalizedClientId, accessToken: normalizedToken, profile };
  scripMasterPromise = null;
  quoteCache = { fetchedAt: 0, quotes: null, key: '' };
  lastCandleRequestAt = 0;
  lastQuoteRequestAt = 0;
  candleCache.clear();
  return publicProfile(profile);
}

function publicProfile(profile = credentials?.profile) {
  if (!profile) return null;
  return {
    clientId: profile.dhanClientId || profile.clientId || credentials?.clientId,
    name: profile.dhanClientName || profile.name || 'Dhan account',
    tokenValidity: profile.tokenValidity || null,
    activeSegment: profile.activeSegment || null,
    dataPlan: profile.dataPlan || null,
    dataValidity: profile.dataValidity || null
  };
}

function getConnection() {
  return credentials ? publicProfile() : null;
}

function disconnect() {
  credentials = null;
  quoteCache = { fetchedAt: 0, quotes: null, key: '' };
  candleCache.clear();
}

function requireConnection() {
  if (!credentials) throw new Error('Connect and verify your Dhan account first.');
}

async function getPositions() {
  requireConnection();
  const result = await requestDhan('/positions');
  return Array.isArray(result.data) ? result.data : [];
}

async function getFunds() {
  requireConnection();
  const result = await requestDhan('/fundlimit');
  return result.data || {};
}

function roundToTick(value, tickSize) {
  const tick = Number(tickSize) || 0.05;
  return Number((Math.round(Number(value) / tick) * tick).toFixed(2));
}

function chooseOptionExpiry(expiries, today = new Date()) {
  const todayDate = istDateTime(today).slice(0, 10);
  const monthlyByMonth = new Map();
  for (const expiry of expiries.filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort()) {
    const month = expiry.slice(0, 7);
    if (!monthlyByMonth.has(month) || expiry > monthlyByMonth.get(month)) {
      monthlyByMonth.set(month, expiry);
    }
  }

  const monthlyExpiries = [...monthlyByMonth.values()].sort();
  const currentMonth = todayDate.slice(0, 7);
  const currentMonthlyExpiry = monthlyExpiries.find((expiry) => expiry.slice(0, 7) === currentMonth && expiry >= todayDate);
  if (!currentMonthlyExpiry) {
    return monthlyExpiries.find((expiry) => expiry >= todayDate) || null;
  }

  const daysToExpiry = (Date.parse(currentMonthlyExpiry + 'T00:00:00Z') - Date.parse(todayDate + 'T00:00:00Z')) / 86400000;
  if (daysToExpiry > 7) return currentMonthlyExpiry;
  return monthlyExpiries.find((expiry) => expiry.slice(0, 7) > currentMonth && expiry >= todayDate) || null;
}

async function getOptionData(underlying, signal) {
  const instruments = await getEquityInstruments();
  const instrument = instruments.find((item) => item.symbol === underlying);
  if (!instrument) throw new Error('Unsupported underlying symbol.');

  const expiryResult = await requestDhan('/optionchain/expirylist', {
    method: 'POST',
    body: JSON.stringify({ UnderlyingScrip: Number(instrument.securityId), UnderlyingSeg: 'NSE_EQ' })
  });

  const expiry = chooseOptionExpiry(expiryResult.data || []);
  if (!expiry) throw new Error(`No next-month stock option expiry is available for ${underlying}.`);

  const waitMs = Math.max(0, 3100 - (Date.now() - lastOptionChainAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastOptionChainAt = Date.now();

  const chainResult = await requestDhan('/optionchain', {
    method: 'POST',
    body: JSON.stringify({ UnderlyingScrip: Number(instrument.securityId), UnderlyingSeg: 'NSE_EQ', Expiry: expiry })
  });

  const chain = chainResult.data || {};
  const desiredOption = signal === 'BUY' ? 'pe' : 'ce';
  const desiredDelta = signal === 'BUY' ? -0.4 : 0.4;
  const candidates = Object.entries(chain.oc || {}).map(([strikeText, legs]) => ({
    strike: Number(strikeText),
    contract: legs[desiredOption]
  })).filter((item) => item.contract?.security_id
    && Number(item.contract.last_price) > 0
    && Number.isFinite(Number(item.contract.greeks?.delta))
    && (signal === 'BUY' ? Number(item.contract.greeks.delta) < 0 : Number(item.contract.greeks.delta) > 0));

  if (!candidates.length) throw new Error(`Dhan returned no ${desiredOption.toUpperCase()} contracts for ${underlying}.`);

  const selected = candidates.reduce((best, item) => Math.abs(Number(item.contract.greeks.delta) - desiredDelta)
    < Math.abs(Number(best.contract.greeks.delta) - desiredDelta) ? item : best);

  if (!selected) throw new Error('Dhan did not return an eligible out-of-the-money option contract.');

  const rows = await getScripMaster();
  const contractMaster = rows.find((row) => String(row.SEM_SMST_SECURITY_ID) === String(selected.contract.security_id));
  const lotUnits = Number(contractMaster?.SEM_LOT_UNITS);
  const tickSize = Number(contractMaster?.SEM_TICK_SIZE) || 0.05;
  const entryPrice = roundToTick(selected.contract.top_bid_price || selected.contract.last_price, tickSize);
  if (!Number.isInteger(lotUnits) || lotUnits < 1 || entryPrice <= 0) {
    throw new Error('Could not validate this option contract lot size or limit price from Dhan.');
  }

  return {
    underlying,
    signal,
    expiry,
    optionType: desiredOption.toUpperCase(),
    strike: selected.strike,
    securityId: String(selected.contract.security_id),
    lotUnits,
    tickSize,
    entryPrice,
    greeks: selected.contract.greeks || null,
    optionLtp: Number(selected.contract.last_price),
    spotPrice: Number(chain.last_price)
  };
}

async function createOptionOrderPreview({ symbol, signal, lots, includeMargin = true }) {
  requireConnection();
  if (!SCAN_SYMBOLS.includes(symbol) || !['BUY', 'SELL'].includes(signal)) {
    throw new Error('Choose a supported symbol with a confirmed BUY or SELL signal.');
  }
  const stopLossPct = 20;
  const targetPct = 50;
  if (!Number.isInteger(lots) || lots < 1 || lots > 1000) {
    throw new Error('Lot size must be 1-1000.');
  }

  const contract = await getOptionData(symbol, signal);
  const quantity = lots * contract.lotUnits;
  const { stopLossPrice, targetPrice } = calculateShortOptionRisk(contract.entryPrice, contract.tickSize);

  let margin = {};
  if (includeMargin) {
    const marginResult = await requestDhan('/margincalculator', {
      method: 'POST',
      body: JSON.stringify({
        dhanClientId: credentials.clientId,
        exchangeSegment: 'NSE_FNO',
        transactionType: 'SELL',
        quantity,
        productType: 'INTRADAY',
        securityId: contract.securityId,
        price: contract.entryPrice,
        triggerPrice: 0
      })
    });
    margin = marginResult.data || {};
  }

  const order = {
    dhanClientId: credentials.clientId,
    correlationId: `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    transactionType: 'SELL',
    exchangeSegment: 'NSE_FNO',
    productType: 'INTRADAY',
    orderType: 'LIMIT',
    validity: 'DAY',
    securityId: contract.securityId,
    quantity,
    price: contract.entryPrice,
    targetPrice,
    stopLossPrice,
    trailingJump: 0
  };

  return {
    order,
    risk: { stopLossPct, targetPct },
    underlying: contract.underlying,
    signal,
    preview: {
      Underlying: contract.underlying,
      Action: `SELL ${contract.optionType}`,
      Expiry: contract.expiry,
      Strike: contract.strike,
      'Dhan security ID': contract.securityId,
      Lots: lots,
      'Units per lot': contract.lotUnits,
      'Total quantity': quantity,
      'Limit price': contract.entryPrice,
      'Order notional': (quantity * contract.entryPrice).toFixed(2),
      'Stop loss price': stopLossPrice,
      'Target price': targetPrice,
      'Estimated margin': margin.totalMargin ?? 'Unavailable',
      'Trailing stop': 'Not exchange-managed; live trailing activation is not enabled'
    },
    warning: 'Short stock options can lose substantially more than the premium received. Verify the signal, option side, expiry, and risk before confirming.'
  };
}

async function placeSuperOrder(order) {
  requireConnection();
  return requestDhan('/super/orders', { method: 'POST', body: JSON.stringify(order) });
}

async function getScripMaster() {
  if (!scripMasterPromise) {
    scripMasterPromise = (async () => {
      const response = await fetch(SCRIP_MASTER_URL, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Could not load Dhan instrument master (${response.status}).`);
      const csv = await response.text();
      return parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true });
    })().catch((error) => {
      scripMasterPromise = null;
      throw error;
    });
  }
  return scripMasterPromise;
}

async function getEquityInstruments() {
  const rows = await getScripMaster();
  return SCAN_SYMBOLS.map((symbol) => {
    const row = rows.find((instrument) => instrument.SEM_EXM_EXCH_ID === 'NSE'
      && instrument.SEM_INSTRUMENT_NAME === 'EQUITY'
      && instrument.SEM_TRADING_SYMBOL === symbol);
    if (!row) throw new Error(`Dhan instrument master did not contain NSE equity ${symbol}.`);
    return { symbol, securityId: String(row.SEM_SMST_SECURITY_ID) };
  });
}

async function getQuotes(instruments, optionSecurityIds = []) {
  const cacheKey = `${instruments.map((item) => item.securityId).join(',')}|${optionSecurityIds.slice().sort().join(',')}`;
  const request = quoteQueue.then(async () => {
    const now = Date.now();
    if (quoteCache.quotes && quoteCache.key === cacheKey && now - quoteCache.fetchedAt < 1100) return quoteCache.quotes;

    const waitMs = Math.max(0, 1050 - (now - lastQuoteRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));

    const securities = { NSE_EQ: instruments.map((instrument) => Number(instrument.securityId)) };
    if (optionSecurityIds.length) securities.NSE_FNO = optionSecurityIds.map(Number);

    const result = await requestDhan('/marketfeed/ltp', {
      method: 'POST',
      body: JSON.stringify(securities)
    });
    lastQuoteRequestAt = Date.now();
    quoteCache = { fetchedAt: lastQuoteRequestAt, key: cacheKey, quotes: result.data || {} };
    return quoteCache.quotes;
  });
  quoteQueue = request.catch(() => {});
  return request;
}

function istDateTime(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((values, part) => ({ ...values, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function istDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((values, part) => ({ ...values, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function emaSeries(values, period) {
  if (values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const series = [values.slice(0, period).reduce((sum, value) => sum + value, 0) / period];
  for (let index = period; index < values.length; index += 1) {
    series.push((values[index] - series[series.length - 1]) * multiplier + series[series.length - 1]);
  }
  return series;
}

function getSupertrendDirection(candles, period = 10, factor = 3) {
  if (candles.length < period + 2) return null;
  const trueRanges = candles.map((candle, index) => {
    if (!index) return candle.high - candle.low;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - candles[index - 1].close), Math.abs(candle.low - candles[index - 1].close));
  });
  let atr = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  let upperBand = 0;
  let lowerBand = 0;
  let direction = 'DOWN';

  for (let index = period; index < candles.length; index += 1) {
    atr = ((atr * (period - 1)) + trueRanges[index]) / period;
    const midpoint = (candles[index].high + candles[index].low) / 2;
    const basicUpper = midpoint + factor * atr;
    const basicLower = midpoint - factor * atr;
    upperBand = !upperBand || basicUpper < upperBand || candles[index - 1].close > upperBand ? basicUpper : upperBand;
    lowerBand = !lowerBand || basicLower > lowerBand || candles[index - 1].close < lowerBand ? basicLower : lowerBand;
    if (direction === 'DOWN' && candles[index].close > upperBand) direction = 'UP';
    else if (direction === 'UP' && candles[index].close < lowerBand) direction = 'DOWN';
  }

  return direction;
}

function buildCandles(data) {
  if (!data || !Array.isArray(data.timestamp)) return [];
  return data.timestamp.map((timestamp, index) => ({
    timestamp: Number(timestamp),
    open: Number(data.open[index]),
    high: Number(data.high[index]),
    low: Number(data.low[index]),
    close: Number(data.close[index]),
    volume: Number(data.volume[index])
  })).filter((candle) => Number.isFinite(candle.timestamp)
    && [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
    .filter((candle) => candle.timestamp + 900 <= Math.floor(Date.now() / 1000));
}

async function getCandles(instrument) {
  const cached = candleCache.get(instrument.securityId);
  if (cached && Date.now() - cached.fetchedAt < 15 * 60 * 1000) return cached.candles;

  const waitMs = Math.max(0, 210 - (Date.now() - lastCandleRequestAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastCandleRequestAt = Date.now();

  const now = new Date();
  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const result = await requestDhan('/charts/intraday', {
    method: 'POST',
    body: JSON.stringify({
      securityId: instrument.securityId,
      exchangeSegment: 'NSE_EQ',
      instrument: 'EQUITY',
      interval: '15',
      oi: false,
      fromDate: istDate(start),
      toDate: istDate(now)
    })
  });

  const candles = buildCandles(result.data);
  candleCache.set(instrument.securityId, { fetchedAt: Date.now(), candles });
  return candles;
}

function dayInIndia(timestamp) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(timestamp * 1000));
}

function calculatePreviousDayCpr(candles) {
  const sessions = new Map();
  for (const candle of candles) {
    const day = dayInIndia(candle.timestamp);
    const session = sessions.get(day) || { high: -Infinity, low: Infinity, close: candle.close };
    session.high = Math.max(session.high, candle.high);
    session.low = Math.min(session.low, candle.low);
    session.close = candle.close;
    sessions.set(day, session);
  }

  const sessionValues = Array.from(sessions.values());
  if (sessionValues.length < 2) return null;
  const previous = sessionValues[sessionValues.length - 2];
  if (!Number.isFinite(previous.close) || previous.close <= 0) return null;

  const pivot = (previous.high + previous.low + previous.close) / 3;
  const base = (previous.high + previous.low) / 2;
  const top = 2 * pivot - base;
  const bottom = Math.min(base, top);
  const ceiling = Math.max(base, top);
  const widthPct = ((ceiling - bottom) / previous.close) * 100;

  return {
    pivot,
    top: ceiling,
    bottom,
    widthPct,
    narrow: widthPct <= 0.5,
    previousClose: previous.close
  };
}

function confirmedSignal({ crossedUp, crossedDown, trend, close, vwap, cpr }) {
  if (!cpr?.narrow || !Number.isFinite(vwap)) return 'WATCH';
  if (crossedUp && trend === 'UP' && close > vwap && close > cpr.top) return 'BUY';
  if (crossedDown && trend === 'DOWN' && close < vwap && close < cpr.bottom) return 'SELL';
  return 'WATCH';
}

function calculateShortOptionRisk(entryPrice, tickSize) {
  return {
    stopLossPrice: roundToTick(entryPrice * 1.2, tickSize),
    targetPrice: roundToTick(Math.max(tickSize, entryPrice * 0.5), tickSize)
  };
}

function calculateIndicators(candles) {
  if (candles.length < 35) return null;
  const closes = candles.map((candle) => candle.close);
  const ema21 = emaSeries(closes, 21);
  const ema34 = emaSeries(closes, 34);
  const currentDay = dayInIndia(Math.floor(Date.now() / 1000));
  const today = candles.filter((candle) => dayInIndia(candle.timestamp) === currentDay);
  const vwapCandles = today.length ? today : candles.filter((candle) => dayInIndia(candle.timestamp) === dayInIndia(candles[candles.length - 1].timestamp));
  const volumeSum = vwapCandles.reduce((sum, candle) => sum + candle.volume, 0);
  const vwap = volumeSum ? vwapCandles.reduce((sum, candle) => sum + ((candle.high + candle.low + candle.close) / 3) * candle.volume, 0) / volumeSum : null;
  const ema21Last = ema21.at(-1);
  const ema34Last = ema34.at(-1);
  const ema21Previous = ema21.at(-2);
  const ema34Previous = ema34.at(-2);
  const trend = getSupertrendDirection(candles);
  const last = candles.at(-1);
  const cpr = calculatePreviousDayCpr(candles);
  const crossedUp = ema21Previous <= ema34Previous && ema21Last > ema34Last;
  const crossedDown = ema21Previous >= ema34Previous && ema21Last < ema34Last;
  const signal = confirmedSignal({
    crossedUp,
    crossedDown,
    trend,
    close: last.close,
    vwap,
    cpr
  });

  return {
    ema21: ema21Last,
    ema34: ema34Last,
    vwap,
    trend,
    signal,
    cpr,
    lastClose: last.close,
    lastCandleAt: new Date(last.timestamp * 1000).toISOString()
  };
}

async function getLiveScan(optionSecurityIds = []) {
  requireConnection();
  const instruments = await getEquityInstruments();
  const quotes = await getQuotes(instruments, optionSecurityIds);
  const rows = [];

  for (const instrument of instruments) {
    const quote = quotes.NSE_EQ?.[instrument.securityId];
    const price = Number(quote?.last_price);
    let indicators = null;
    let dataError = null;

    try {
      const candles = await getCandles(instrument);
      indicators = calculateIndicators(candles);
    } catch (error) {
      dataError = error.message;
    }

    rows.push({
      symbol: instrument.symbol,
      securityId: instrument.securityId,
      timeframe: '15m',
      price: Number.isFinite(price) ? price : null,
      ema21: indicators?.ema21 ?? null,
      ema34: indicators?.ema34 ?? null,
      vwap: indicators?.vwap ?? null,
      cpr: indicators?.cpr || null,
      supertrend: indicators?.trend || 'UNAVAILABLE',
      signal: indicators?.signal || 'WATCH',
      trend: indicators?.trend || 'Unavailable',
      setup: indicators?.signal === 'BUY' ? 'SELL PUT' : indicators?.signal === 'SELL' ? 'SELL CALL' : 'WAIT',
      lastCandleAt: indicators?.lastCandleAt || null,
      dataError
    });
  }

  return { results: rows, optionQuotes: quotes.NSE_FNO || {} };
}

module.exports = {
  connect,
  disconnect,
  getConnection,
  getPositions,
  getFunds,
  getLiveScan,
  createOptionOrderPreview,
  placeSuperOrder,
  requireConnection,
  chooseOptionExpiry,
  istDate,
  calculatePreviousDayCpr,
  confirmedSignal,
  calculateShortOptionRisk
};
'use strict';

const { parse } = require('csv-parse/sync');

const API_BASE = 'https://api.dhan.co/v2';
const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const SCAN_SYMBOLS = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'SBIN', 'ICICIBANK', 'LTIM', 'TECHM', 'BAJFINANCE', 'AXISBANK'];

let credentials = null;
let scripMasterPromise = null;
let quoteCache = { fetchedAt: 0, quotes: null, key: '' };
let lastCandleRequestAt = 0;
let lastOptionChainAt = 0;
let lastQuoteRequestAt = 0;
let quoteQueue = Promise.resolve();
const candleCache = new Map();

function safeErrorMessage(payload, fallback) {
  return payload?.errorMessage || payload?.remarks?.error_message || payload?.message || fallback;
}

async function requestDhan(path, options = {}, token = credentials?.accessToken) {
  if (!token) throw new Error('Connect a Dhan account first.');

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    signal: AbortSignal.timeout(15000),
    headers: {
      'access-token': token,
      ...(credentials?.clientId ? { 'client-id': credentials.clientId } : {}),
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.status === 'failure') {
    const error = new Error(safeErrorMessage(payload, `Dhan API request failed (${response.status}).`));
    error.statusCode = response.status;
    throw error;
  }

  return payload;
}

async function connect(clientId, accessToken) {
  if (typeof clientId !== 'string' || !/^\d{6,12}$/.test(clientId.trim())) {
    throw new Error('Enter the Dhan Client ID shown in your Dhan profile.');
  }
  if (typeof accessToken !== 'string' || accessToken.trim().length < 20 || accessToken.length > 4096) {
    throw new Error('Enter a valid Dhan access token.');
  }

  const normalizedClientId = clientId.trim();
  const normalizedToken = accessToken.trim();
  const result = await requestDhan('/profile', {
    headers: { 'client-id': normalizedClientId }
  }, normalizedToken);
  const profile = result.data || result;
  const profileClientId = String(profile.dhanClientId || profile.clientId || '').trim();

  if (profileClientId && profileClientId !== normalizedClientId) {
    throw new Error('The token belongs to a different Dhan Client ID.');
  }

  credentials = { clientId: normalizedClientId, accessToken: normalizedToken, profile };
  scripMasterPromise = null;
  quoteCache = { fetchedAt: 0, quotes: null, key: '' };
  lastCandleRequestAt = 0;
  lastQuoteRequestAt = 0;
  candleCache.clear();
  return publicProfile(profile);
}

function publicProfile(profile = credentials?.profile) {
  if (!profile) return null;
  return {
    clientId: profile.dhanClientId || profile.clientId || credentials?.clientId,
    name: profile.dhanClientName || profile.name || 'Dhan account',
    tokenValidity: profile.tokenValidity || null,
    activeSegment: profile.activeSegment || null,
    dataPlan: profile.dataPlan || null,
    dataValidity: profile.dataValidity || null
  };
}

function getConnection() {
  return credentials ? publicProfile() : null;
}

function disconnect() {
  credentials = null;
  quoteCache = { fetchedAt: 0, quotes: null, key: '' };
  candleCache.clear();
}

function requireConnection() {
  if (!credentials) throw new Error('Connect and verify your Dhan account first.');
}

async function getPositions() {
  requireConnection();
  const result = await requestDhan('/positions');
  return Array.isArray(result.data) ? result.data : [];
}

async function getFunds() {
  requireConnection();
  const result = await requestDhan('/fundlimit');
  return result.data || {};
}

function roundToTick(value, tickSize) {
  const tick = Number(tickSize) || 0.05;
  return Number((Math.round(Number(value) / tick) * tick).toFixed(2));
}

function chooseOptionExpiry(expiries, today = new Date()) {
  const todayDate = istDateTime(today).slice(0, 10);
  const futureExpiries = expiries.filter((value) => value >= todayDate).sort();
  let expiry = futureExpiries[0];
  if (!expiry) return null;

  const expiryMidnight = new Date(`${expiry}T00:00:00+05:30`);
  const todayMidnight = new Date(`${todayDate}T00:00:00+05:30`);
  const daysToExpiry = Math.ceil((expiryMidnight - todayMidnight) / (24 * 60 * 60 * 1000));
  if (daysToExpiry <= 7) {
    const [year, month] = expiry.split('-').map(Number);
    const expiryMonth = year * 12 + month;
    expiry = futureExpiries.find((value) => {
      const [candidateYear, candidateMonth] = value.split('-').map(Number);
      return candidateYear * 12 + candidateMonth > expiryMonth;
    });
  }
  return expiry || null;
}

async function getOptionData(underlying, signal) {
  const instruments = await getEquityInstruments();
  const instrument = instruments.find((item) => item.symbol === underlying);
  if (!instrument) throw new Error('Unsupported underlying symbol.');

  const expiryResult = await requestDhan('/optionchain/expirylist', {
    method: 'POST',
    body: JSON.stringify({ UnderlyingScrip: Number(instrument.securityId), UnderlyingSeg: 'NSE_EQ' })
  });

  const expiry = chooseOptionExpiry(expiryResult.data || []);
  if (!expiry) throw new Error(`No next-month stock option expiry is available for ${underlying}.`);

  const waitMs = Math.max(0, 3100 - (Date.now() - lastOptionChainAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastOptionChainAt = Date.now();

  const chainResult = await requestDhan('/optionchain', {
    method: 'POST',
    body: JSON.stringify({ UnderlyingScrip: Number(instrument.securityId), UnderlyingSeg: 'NSE_EQ', Expiry: expiry })
  });

  const chain = chainResult.data || {};
  const desiredOption = signal === 'BUY' ? 'pe' : 'ce';
  const desiredDelta = signal === 'BUY' ? -0.4 : 0.4;
  const candidates = Object.entries(chain.oc || {}).map(([strikeText, legs]) => ({
    strike: Number(strikeText),
    contract: legs[desiredOption]
  })).filter((item) => item.contract?.security_id
    && Number(item.contract.last_price) > 0
    && Number.isFinite(Number(item.contract.greeks?.delta))
    && (signal === 'BUY' ? Number(item.contract.greeks.delta) < 0 : Number(item.contract.greeks.delta) > 0));

  if (!candidates.length) throw new Error(`Dhan returned no ${desiredOption.toUpperCase()} contracts for ${underlying}.`);

  const selected = candidates.reduce((best, item) => Math.abs(Number(item.contract.greeks.delta) - desiredDelta)
    < Math.abs(Number(best.contract.greeks.delta) - desiredDelta) ? item : best);

  if (!selected) throw new Error('Dhan did not return an eligible out-of-the-money option contract.');

  const rows = await getScripMaster();
  const contractMaster = rows.find((row) => String(row.SEM_SMST_SECURITY_ID) === String(selected.contract.security_id));
  const lotUnits = Number(contractMaster?.SEM_LOT_UNITS);
  const tickSize = Number(contractMaster?.SEM_TICK_SIZE) || 0.05;
  const entryPrice = roundToTick(selected.contract.top_bid_price || selected.contract.last_price, tickSize);
  if (!Number.isInteger(lotUnits) || lotUnits < 1 || entryPrice <= 0) {
    throw new Error('Could not validate this option contract lot size or limit price from Dhan.');
  }

  return {
    underlying,
    signal,
    expiry,
    optionType: desiredOption.toUpperCase(),
    strike: selected.strike,
    securityId: String(selected.contract.security_id),
    lotUnits,
    tickSize,
    entryPrice,
    greeks: selected.contract.greeks || null,
    optionLtp: Number(selected.contract.last_price),
    spotPrice: Number(chain.last_price)
  };
}

async function createOptionOrderPreview({ symbol, signal, lots, includeMargin = true }) {
  requireConnection();
  if (!SCAN_SYMBOLS.includes(symbol) || !['BUY', 'SELL'].includes(signal)) {
    throw new Error('Choose a supported symbol with a confirmed BUY or SELL signal.');
  }
  const stopLossPct = 20;
  const targetPct = 50;
  if (!Number.isInteger(lots) || lots < 1 || lots > 1000) {
    throw new Error('Lot size must be 1-1000.');
  }

  const contract = await getOptionData(symbol, signal);
  const quantity = lots * contract.lotUnits;
  const { stopLossPrice, targetPrice } = calculateShortOptionRisk(contract.entryPrice, contract.tickSize);

  let margin = {};
  if (includeMargin) {
    const marginResult = await requestDhan('/margincalculator', {
      method: 'POST',
      body: JSON.stringify({
        dhanClientId: credentials.clientId,
        exchangeSegment: 'NSE_FNO',
        transactionType: 'SELL',
        quantity,
        productType: 'INTRADAY',
        securityId: contract.securityId,
        price: contract.entryPrice,
        triggerPrice: 0
      })
    });
    margin = marginResult.data || {};
  }

  const order = {
    dhanClientId: credentials.clientId,
    correlationId: `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    transactionType: 'SELL',
    exchangeSegment: 'NSE_FNO',
    productType: 'INTRADAY',
    orderType: 'LIMIT',
    validity: 'DAY',
    securityId: contract.securityId,
    quantity,
    price: contract.entryPrice,
    targetPrice,
    stopLossPrice,
    trailingJump: 0
  };

  return {
    order,
    risk: { stopLossPct, targetPct },
    underlying: contract.underlying,
    signal,
    preview: {
      Underlying: contract.underlying,
      Action: `SELL ${contract.optionType}`,
      Expiry: contract.expiry,
      Strike: contract.strike,
      'Dhan security ID': contract.securityId,
      Lots: lots,
      'Units per lot': contract.lotUnits,
      'Total quantity': quantity,
      'Limit price': contract.entryPrice,
      'Order notional': (quantity * contract.entryPrice).toFixed(2),
      'Stop loss price': stopLossPrice,
      'Target price': targetPrice,
      'Estimated margin': margin.totalMargin ?? 'Unavailable',
      'Trailing stop': 'Not exchange-managed; live trailing activation is not enabled'
    },
    warning: 'Short stock options can lose substantially more than the premium received. Verify the signal, option side, expiry, and risk before confirming.'
  };
}

async function placeSuperOrder(order) {
  requireConnection();
  return requestDhan('/super/orders', { method: 'POST', body: JSON.stringify(order) });
}

async function getScripMaster() {
  if (!scripMasterPromise) {
    scripMasterPromise = (async () => {
      const response = await fetch(SCRIP_MASTER_URL, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Could not load Dhan instrument master (${response.status}).`);
      const csv = await response.text();
      return parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true });
    })().catch((error) => {
      scripMasterPromise = null;
      throw error;
    });
  }
  return scripMasterPromise;
}

async function getEquityInstruments() {
  const rows = await getScripMaster();
  return SCAN_SYMBOLS.map((symbol) => {
    const row = rows.find((instrument) => instrument.SEM_EXM_EXCH_ID === 'NSE'
      && instrument.SEM_INSTRUMENT_NAME === 'EQUITY'
      && instrument.SEM_TRADING_SYMBOL === symbol);
    if (!row) throw new Error(`Dhan instrument master did not contain NSE equity ${symbol}.`);
    return { symbol, securityId: String(row.SEM_SMST_SECURITY_ID) };
  });
}

async function getQuotes(instruments, optionSecurityIds = []) {
  const cacheKey = `${instruments.map((item) => item.securityId).join(',')}|${optionSecurityIds.slice().sort().join(',')}`;
  const request = quoteQueue.then(async () => {
    const now = Date.now();
    if (quoteCache.quotes && quoteCache.key === cacheKey && now - quoteCache.fetchedAt < 1100) return quoteCache.quotes;

    const waitMs = Math.max(0, 1050 - (now - lastQuoteRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));

    const securities = { NSE_EQ: instruments.map((instrument) => Number(instrument.securityId)) };
    if (optionSecurityIds.length) securities.NSE_FNO = optionSecurityIds.map(Number);

    const result = await requestDhan('/marketfeed/ltp', {
      method: 'POST',
      body: JSON.stringify(securities)
    });
    lastQuoteRequestAt = Date.now();
    quoteCache = { fetchedAt: lastQuoteRequestAt, key: cacheKey, quotes: result.data || {} };
    return quoteCache.quotes;
  });
  quoteQueue = request.catch(() => {});
  return request;
}

function istDateTime(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((values, part) => ({ ...values, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function istDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((values, part) => ({ ...values, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function emaSeries(values, period) {
  if (values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const series = [values.slice(0, period).reduce((sum, value) => sum + value, 0) / period];
  for (let index = period; index < values.length; index += 1) {
    series.push((values[index] - series[series.length - 1]) * multiplier + series[series.length - 1]);
  }
  return series;
}

function getSupertrendDirection(candles, period = 10, factor = 3) {
  if (candles.length < period + 2) return null;
  const trueRanges = candles.map((candle, index) => {
    if (!index) return candle.high - candle.low;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - candles[index - 1].close), Math.abs(candle.low - candles[index - 1].close));
  });
  let atr = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  let upperBand = 0;
  let lowerBand = 0;
  let direction = 'DOWN';

  for (let index = period; index < candles.length; index += 1) {
    atr = ((atr * (period - 1)) + trueRanges[index]) / period;
    const midpoint = (candles[index].high + candles[index].low) / 2;
    const basicUpper = midpoint + factor * atr;
    const basicLower = midpoint - factor * atr;
    upperBand = !upperBand || basicUpper < upperBand || candles[index - 1].close > upperBand ? basicUpper : upperBand;
    lowerBand = !lowerBand || basicLower > lowerBand || candles[index - 1].close < lowerBand ? basicLower : lowerBand;
    if (direction === 'DOWN' && candles[index].close > upperBand) direction = 'UP';
    else if (direction === 'UP' && candles[index].close < lowerBand) direction = 'DOWN';
  }

  return direction;
}

function buildCandles(data) {
  if (!data || !Array.isArray(data.timestamp)) return [];
  return data.timestamp.map((timestamp, index) => ({
    timestamp: Number(timestamp),
    open: Number(data.open[index]),
    high: Number(data.high[index]),
    low: Number(data.low[index]),
    close: Number(data.close[index]),
    volume: Number(data.volume[index])
  })).filter((candle) => Number.isFinite(candle.timestamp)
    && [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
    .filter((candle) => candle.timestamp + 900 <= Math.floor(Date.now() / 1000));
}

async function getCandles(instrument) {
  const cached = candleCache.get(instrument.securityId);
  if (cached && Date.now() - cached.fetchedAt < 15 * 60 * 1000) return cached.candles;

  const waitMs = Math.max(0, 210 - (Date.now() - lastCandleRequestAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastCandleRequestAt = Date.now();

  const now = new Date();
  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const result = await requestDhan('/charts/intraday', {
    method: 'POST',
    body: JSON.stringify({
      securityId: instrument.securityId,
      exchangeSegment: 'NSE_EQ',
      instrument: 'EQUITY',
      interval: '15',
      oi: false,
      fromDate: istDate(start),
      toDate: istDate(now)
    })
  });

  const candles = buildCandles(result.data);
  candleCache.set(instrument.securityId, { fetchedAt: Date.now(), candles });
  return candles;
}

function dayInIndia(timestamp) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(timestamp * 1000));
}

function calculatePreviousDayCpr(candles) {
  const sessions = new Map();
  for (const candle of candles) {
    const day = dayInIndia(candle.timestamp);
    const session = sessions.get(day) || { high: -Infinity, low: Infinity, close: candle.close };
    session.high = Math.max(session.high, candle.high);
    session.low = Math.min(session.low, candle.low);
    session.close = candle.close;
    sessions.set(day, session);
  }

  const sessionValues = Array.from(sessions.values());
  if (sessionValues.length < 2) return null;
  const previous = sessionValues[sessionValues.length - 2];
  if (!Number.isFinite(previous.close) || previous.close <= 0) return null;

  const pivot = (previous.high + previous.low + previous.close) / 3;
  const base = (previous.high + previous.low) / 2;
  const top = 2 * pivot - base;
  const bottom = Math.min(base, top);
  const ceiling = Math.max(base, top);
  const widthPct = ((ceiling - bottom) / previous.close) * 100;

  return {
    pivot,
    top: ceiling,
    bottom,
    widthPct,
    narrow: widthPct <= 0.5,
    previousClose: previous.close
  };
}

function confirmedSignal({ crossedUp, crossedDown, trend, close, vwap, cpr }) {
  if (!cpr?.narrow || !Number.isFinite(vwap)) return 'WATCH';
  if (crossedUp && trend === 'UP' && close > vwap && close > cpr.top) return 'BUY';
  if (crossedDown && trend === 'DOWN' && close < vwap && close < cpr.bottom) return 'SELL';
  return 'WATCH';
}

function calculateShortOptionRisk(entryPrice, tickSize) {
  return {
    stopLossPrice: roundToTick(entryPrice * 1.2, tickSize),
    targetPrice: roundToTick(Math.max(tickSize, entryPrice * 0.5), tickSize)
  };
}

function calculateIndicators(candles) {
  if (candles.length < 35) return null;
  const closes = candles.map((candle) => candle.close);
  const ema21 = emaSeries(closes, 21);
  const ema34 = emaSeries(closes, 34);
  const currentDay = dayInIndia(Math.floor(Date.now() / 1000));
  const today = candles.filter((candle) => dayInIndia(candle.timestamp) === currentDay);
  const vwapCandles = today.length ? today : candles.filter((candle) => dayInIndia(candle.timestamp) === dayInIndia(candles[candles.length - 1].timestamp));
  const volumeSum = vwapCandles.reduce((sum, candle) => sum + candle.volume, 0);
  const vwap = volumeSum ? vwapCandles.reduce((sum, candle) => sum + ((candle.high + candle.low + candle.close) / 3) * candle.volume, 0) / volumeSum : null;
  const ema21Last = ema21.at(-1);
  const ema34Last = ema34.at(-1);
  const ema21Previous = ema21.at(-2);
  const ema34Previous = ema34.at(-2);
  const trend = getSupertrendDirection(candles);
  const last = candles.at(-1);
  const cpr = calculatePreviousDayCpr(candles);
  const crossedUp = ema21Previous <= ema34Previous && ema21Last > ema34Last;
  const crossedDown = ema21Previous >= ema34Previous && ema21Last < ema34Last;
  const signal = confirmedSignal({
    crossedUp,
    crossedDown,
    trend,
    close: last.close,
    vwap,
    cpr
  });

  return {
    ema21: ema21Last,
    ema34: ema34Last,
    vwap,
    trend,
    signal,
    cpr,
    lastClose: last.close,
    lastCandleAt: new Date(last.timestamp * 1000).toISOString()
  };
}

async function getLiveScan(optionSecurityIds = []) {
  requireConnection();
  const instruments = await getEquityInstruments();
  const quotes = await getQuotes(instruments, optionSecurityIds);
  const rows = [];

  for (const instrument of instruments) {
    const quote = quotes.NSE_EQ?.[instrument.securityId];
    const price = Number(quote?.last_price);
    let indicators = null;
    let dataError = null;

    try {
      const candles = await getCandles(instrument);
      indicators = calculateIndicators(candles);
    } catch (error) {
      dataError = error.message;
    }

    rows.push({
      symbol: instrument.symbol,
      securityId: instrument.securityId,
      timeframe: '15m',
      price: Number.isFinite(price) ? price : null,
      ema21: indicators?.ema21 ?? null,
      ema34: indicators?.ema34 ?? null,
      vwap: indicators?.vwap ?? null,
      cpr: indicators?.cpr || null,
      supertrend: indicators?.trend || 'UNAVAILABLE',
      signal: indicators?.signal || 'WATCH',
      trend: indicators?.trend || 'Unavailable',
      setup: indicators?.signal === 'BUY' ? 'SELL PUT' : indicators?.signal === 'SELL' ? 'SELL CALL' : 'WAIT',
      lastCandleAt: indicators?.lastCandleAt || null,
      dataError
    });
  }

  return { results: rows, optionQuotes: quotes.NSE_FNO || {} };
}

module.exports = {
  connect,
  disconnect,
  getConnection,
  getPositions,
  getFunds,
  getLiveScan,
  createOptionOrderPreview,
  placeSuperOrder,
  requireConnection,
  chooseOptionExpiry,
  istDate,
  calculatePreviousDayCpr,
  confirmedSignal,
  calculateShortOptionRisk
};
