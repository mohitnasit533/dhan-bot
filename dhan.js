'use strict';

const { parse } = require('csv-parse/sync');

const API_BASE = 'https://api.dhan.co/v2';
const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

let credentials = null;
let connectionVerification = { verified: false, verifiedAt: null, error: null };
let scripMasterPromise = null;
let quoteCache = { fetchedAt: 0, quotes: null, key: '' };
let lastCandleRequestAt = 0;
let lastOptionChainAt = 0;
let lastQuoteRequestAt = 0;
let quoteQueue = Promise.resolve();
const candleCache = new Map();
const indicatorCache = new Map();
let candleRefreshPromise = null;
let scripMasterFetchedAt = 0;
let equityInstrumentsCache = null;
let equityInstrumentsCachedAt = 0;
const candleRefreshErrors = new Map();

function safeErrorMessage(payload, fallback) {
  return payload?.errorMessage || payload?.remarks?.error_message
    || (typeof payload?.remarks === 'string' ? payload.remarks : null)
    || payload?.message || fallback;
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

  if (!profileClientId) {
    throw new Error('Dhan profile verification did not return a Client ID.');
  }
  if (profileClientId !== normalizedClientId) {
    throw new Error('The token belongs to a different Dhan Client ID.');
  }

  credentials = { clientId: normalizedClientId, accessToken: normalizedToken, profile };
  connectionVerification = { verified: true, verifiedAt: new Date().toISOString(), error: null };
  scripMasterPromise = null;
  scripMasterFetchedAt = 0;
  equityInstrumentsCache = null;
  equityInstrumentsCachedAt = 0;
  quoteCache = { fetchedAt: 0, quotes: null, key: '' };
  lastCandleRequestAt = 0;
  lastQuoteRequestAt = 0;
  candleCache.clear();
  indicatorCache.clear();
  return publicProfile(profile);
}

async function verifyConnection() {
  requireConnection();
  try {
    const result = await requestDhan('/profile');
    const profile = result.data || result;
    const profileClientId = String(profile.dhanClientId || profile.clientId || '').trim();
    if (!profileClientId || profileClientId !== credentials.clientId) {
      throw new Error(profileClientId
        ? 'The verified profile belongs to a different Dhan Client ID.'
        : 'Dhan profile verification did not return a Client ID.');
    }
    credentials.profile = profile;
    connectionVerification = { verified: true, verifiedAt: new Date().toISOString(), error: null };
    return publicProfile(profile);
  } catch (error) {
    connectionVerification = { verified: false, verifiedAt: new Date().toISOString(), error: error.message };
    throw error;
  }
}

function getConnectionVerification() {
  return { ...connectionVerification };
}

async function renewAccessToken() {
  requireConnection();
  const { clientId, accessToken } = credentials;
  const response = await fetch(`${API_BASE}/RenewToken`, {
    method: 'GET',
    signal: AbortSignal.timeout(15000),
    headers: {
      'access-token': accessToken,
      dhanClientId: clientId
    }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status === 'failure') {
    throw new Error(safeErrorMessage(payload, `Dhan token renewal failed (${response.status}).`));
  }

  const renewedToken = payload?.accessToken || payload?.data?.accessToken;
  if (typeof renewedToken !== 'string' || renewedToken.length < 20) {
    throw new Error('Dhan token renewal returned no valid access token.');
  }
  const renewedClientId = String(payload?.dhanClientId || payload?.data?.dhanClientId || '').trim();
  if (renewedClientId && renewedClientId !== clientId) {
    throw new Error('Dhan token renewal returned credentials for a different Client ID.');
  }

  credentials.accessToken = renewedToken;
  return {
    accessToken: renewedToken,
    expiryTime: payload.expiryTime || payload.data?.expiryTime || null
  };
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
  connectionVerification = { verified: false, verifiedAt: null, error: null };
  quoteCache = { fetchedAt: 0, quotes: null, key: '' };
  candleCache.clear();
  indicatorCache.clear();
}

function requireConnection() {
  if (!credentials) throw new Error('Connect and verify your Dhan account first.');
}

async function getPositions() {
  requireConnection();
  const result = await requestDhan('/positions');
  return Array.isArray(result.data) ? result.data : [];
}

async function getSuperOrders() {
  requireConnection();
  const result = await requestDhan('/super/orders');
  return Array.isArray(result.data) ? result.data : (Array.isArray(result) ? result : []);
}

async function getOrders() {
  requireConnection();
  const result = await requestDhan('/orders');
  return Array.isArray(result.data) ? result.data : (Array.isArray(result) ? result : []);
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
    if (!monthlyByMonth.has(month) || expiry > monthlyByMonth.get(month)) monthlyByMonth.set(month, expiry);
  }
  const monthlyExpiries = [...monthlyByMonth.values()].sort();
  const currentMonth = todayDate.slice(0, 7);
  const currentMonthlyExpiry = monthlyExpiries.find((value) => value.slice(0, 7) === currentMonth && value >= todayDate);
  if (!currentMonthlyExpiry) return monthlyExpiries.find((value) => value >= todayDate) || null;
  const daysToExpiry = (Date.parse(currentMonthlyExpiry + 'T00:00:00Z') - Date.parse(todayDate + 'T00:00:00Z')) / 86400000;
  if (daysToExpiry > 7) return currentMonthlyExpiry;
  return monthlyExpiries.find((value) => value.slice(0, 7) > currentMonth && value >= todayDate) || null;
}

function optionTargetForSignal(signal) {
  if (signal === 'BUY') return { option: 'pe', delta: -0.4 };
  if (signal === 'SELL') return { option: 'ce', delta: 0.4 };
  throw new Error('Choose a confirmed BUY or SELL signal to select an option.');
}

function meetsOptionLiquidity(contract, settings = {}) {
  const oi = Number(contract?.oi ?? contract?.open_interest);
  const bid = Number(contract?.top_bid_price);
  const ask = Number(contract?.top_ask_price);
  const minimumOi = Number(settings.minOpenInterest);
  const maximumSpreadPct = Number(settings.maxSpreadPct);
  if (![oi, bid, ask, minimumOi, maximumSpreadPct].every(Number.isFinite)
    || minimumOi <= 0 || maximumSpreadPct <= 0
    || oi < minimumOi || bid <= 0 || ask < bid) return false;
  const midpoint = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / midpoint) * 100;
  return spreadPct <= maximumSpreadPct;
}

async function getOptionData(underlying, signal, liquiditySettings = {}) {
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
  const { option: desiredOption, delta: desiredDelta } = optionTargetForSignal(signal);
  const candidates = Object.entries(chain.oc || {}).map(([strikeText, legs]) => ({
    strike: Number(strikeText),
    contract: legs[desiredOption]
  })).filter((item) => item.contract?.security_id
    && Number(item.contract.last_price) > 0
    && Number.isFinite(Number(item.contract.greeks?.delta))
    && (signal === 'BUY' ? Number(item.contract.greeks.delta) < 0 : Number(item.contract.greeks.delta) > 0)
    && meetsOptionLiquidity(item.contract, liquiditySettings));

  if (!candidates.length) {
    throw new Error(`No ${desiredOption.toUpperCase()} contract for ${underlying} met the configured OI and bid/ask spread limits.`);
  }

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
    openInterest: Number(selected.contract.oi ?? selected.contract.open_interest),
    bidPrice: Number(selected.contract.top_bid_price),
    askPrice: Number(selected.contract.top_ask_price),
    greeks: selected.contract.greeks || null,
    optionLtp: Number(selected.contract.last_price),
    spotPrice: Number(chain.last_price)
  };
}

async function checkOrderMargin(order) {
  requireConnection();
  const result = await requestDhan('/margincalculator', {
    method: 'POST',
    body: JSON.stringify({
      dhanClientId: credentials.clientId,
      exchangeSegment: order.exchangeSegment,
      transactionType: order.transactionType,
      quantity: order.quantity,
      productType: order.productType,
      securityId: order.securityId,
      price: order.price,
      triggerPrice: 0
    })
  });
  const margin = result.data || {};
  const funds = await getFunds();
  const required = Number(margin.totalMargin);
  const available = Number(funds.availabelBalance ?? funds.availableBalance);
  if (margin.insufficientBalance === true || String(margin.insufficientBalance).toLowerCase() === 'true') {
    throw new Error('Dhan reports insufficient available funds for this order.');
  }
  if (!Number.isFinite(required) || required < 0 || !Number.isFinite(available) || available < required) {
    throw new Error('Could not confirm sufficient available funds for the estimated Dhan margin. Live order blocked.');
  }
  return { ...margin, availableFunds: available, sufficient: true };
}

async function createOptionOrderPreview({ symbol, signal, lots, includeMargin = true, riskSettings = {} }) {
  requireConnection();
  const supportedSymbols = new Set((await getEquityInstruments()).map((instrument) => instrument.symbol));
  if (!supportedSymbols.has(symbol) || !['BUY', 'SELL'].includes(signal)) {
    throw new Error('Choose a supported symbol with a confirmed BUY or SELL signal.');
  }
  if (!Number.isInteger(lots) || lots < 1 || lots > 1000) {
    throw new Error('Lot size must be 1-1000.');
  }

  const contract = await getOptionData(symbol, signal, riskSettings);
  const quantity = lots * contract.lotUnits;
  const { stopLossPrice, targetPrice } = calculateShortOptionRisk(
    contract.entryPrice, contract.tickSize, quantity,
    riskSettings.stopLossInr, riskSettings.targetInr
  );

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
  const margin = includeMargin ? await checkOrderMargin(order) : {};

  return {
    order,
    risk: { stopLossInr: Number(riskSettings.stopLossInr), targetInr: Number(riskSettings.targetInr) },
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
      'Open interest': contract.openInterest,
      'Bid/ask spread (%)': (((contract.askPrice - contract.bidPrice) / ((contract.askPrice + contract.bidPrice) / 2)) * 100).toFixed(2),
      'Stop loss price': stopLossPrice,
      'Target price': targetPrice,
      'Estimated margin': margin.totalMargin ?? 'Unavailable',
      'Available funds': margin.availableFunds ?? 'Not checked',
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
  if (!scripMasterPromise || Date.now() - scripMasterFetchedAt > 6 * 60 * 60 * 1000) {
    scripMasterFetchedAt = Date.now();
    equityInstrumentsCache = null;
    scripMasterPromise = (async () => {
      const response = await fetch(SCRIP_MASTER_URL, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Could not load Dhan instrument master (${response.status}).`);
      const csv = await response.text();
      return parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true });
    })().catch((error) => {
      scripMasterPromise = null;
      scripMasterFetchedAt = 0;
      throw error;
    });
  }
  return scripMasterPromise;
}

function deriveFnoEquityInstruments(rows, today = istDate(new Date())) {
  const optionSymbols = new Set(rows.filter((row) => row.SEM_EXM_EXCH_ID === 'NSE'
      && row.SEM_INSTRUMENT_NAME === 'OPTSTK'
      && String(row.SEM_EXPIRY_DATE || '').slice(0, 10) >= today)
    .map((row) => String(row.SM_SYMBOL_NAME || '').trim())
    .filter(Boolean));
  const equitiesBySymbol = new Map(rows.filter((row) => row.SEM_EXM_EXCH_ID === 'NSE'
      && row.SEM_INSTRUMENT_NAME === 'EQUITY')
    .map((row) => [String(row.SEM_TRADING_SYMBOL || '').trim(), row]));
  return [...optionSymbols].sort().flatMap((symbol) => {
    const equity = equitiesBySymbol.get(symbol);
    return equity ? [{ symbol, securityId: String(equity.SEM_SMST_SECURITY_ID) }] : [];
  });
}

async function getEquityInstruments() {
  if (equityInstrumentsCache && Date.now() - equityInstrumentsCachedAt < 6 * 60 * 60 * 1000) return equityInstrumentsCache;
  const rows = await getScripMaster();
  const instruments = deriveFnoEquityInstruments(rows);
  if (!instruments.length) throw new Error('Dhan instrument master contained no NSE stock-option underlyings.');
  equityInstrumentsCache = instruments;
  equityInstrumentsCachedAt = Date.now();
  return instruments;
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

    const result = await requestDhan('/marketfeed/quote', {
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

function isEntryWindowOpen(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((values, part) => ({ ...values, [part.type]: part.value }), {});
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return !['Sat', 'Sun'].includes(parts.weekday) && minutes >= 585 && minutes < 840;
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
  const start = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
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

function scheduleCandleRefresh(instruments) {
  if (candleRefreshPromise) return;
  candleRefreshPromise = (async () => {
    for (const instrument of instruments) {
      const cached = candleCache.get(instrument.securityId);
      if (cached && Date.now() - cached.fetchedAt < 15 * 60 * 1000) continue;
      try {
        await getCandles(instrument);
        candleRefreshErrors.delete(instrument.securityId);
      } catch (error) {
        candleRefreshErrors.set(instrument.securityId, error.message);
      }
    }
  })().finally(() => { candleRefreshPromise = null; });
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

function getOpeningGapSetup(candles, date = new Date()) {
  if (candles.length < 35) return { active: false, status: 'UNAVAILABLE', signal: 'WATCH' };
  const today = istDate(date);
  const todayIndices = candles.map((candle, index) => ({ candle, index }))
    .filter(({ candle }) => dayInIndia(candle.timestamp) === today);
  if (!todayIndices.length) return { active: false, status: 'NO_GAP', signal: 'WATCH' };

  const firstToday = todayIndices[0];
  let previousSession = null;
  for (let index = firstToday.index - 1; index >= 0; index -= 1) {
    const session = dayInIndia(candles[index].timestamp);
    if (session !== today) {
      previousSession = session;
      break;
    }
  }
  if (!previousSession) return { active: false, status: 'NO_GAP', signal: 'WATCH' };

  const previousClose = candles.slice(0, firstToday.index)
    .filter((candle) => dayInIndia(candle.timestamp) === previousSession)
    .at(-1)?.close;
  if (!Number.isFinite(previousClose) || previousClose <= 0) {
    return { active: false, status: 'NO_GAP', signal: 'WATCH' };
  }
  const gapPct = ((firstToday.candle.open - previousClose) / previousClose) * 100;
  if (!Number.isFinite(gapPct) || Math.abs(gapPct) < 3) {
    return { active: false, status: 'NO_GAP', signal: 'WATCH' };
  }
  const gapDirection = gapPct > 0 ? 'UP' : 'DOWN';

  const closes = candles.map((candle) => candle.close);
  const ema21 = emaSeries(closes, 21);
  const ema34 = emaSeries(closes, 34);
  const bandCandle = todayIndices.find(({ candle, index }) => {
    if (index < 33) return false;
    const ema21Value = ema21[index - 20];
    const ema34Value = ema34[index - 33];
    return candle.close >= Math.min(ema21Value, ema34Value)
      && candle.close <= Math.max(ema21Value, ema34Value);
  });
  if (!bandCandle) {
    return { active: true, direction: gapDirection, status: 'WAITING_FOR_EMA_BAND', signal: 'WATCH', gapPct: Math.abs(gapPct) };
  }

  let sawCloseAboveEma21 = false;
  let confirmation = null;
  for (const item of todayIndices) {
    const { candle, index } = item;
    if (index <= bandCandle.index || index < 33) continue;
    const ema21Value = ema21[index - 20];
    if (gapDirection === 'UP' && candle.close > ema21Value) {
      confirmation = { ...item, signal: 'BUY' };
      break;
    }
    if (gapDirection === 'DOWN') {
      if (candle.close > ema21Value) {
        sawCloseAboveEma21 = true;
      } else if (sawCloseAboveEma21 && candle.close < ema21Value) {
        confirmation = { ...item, signal: 'SELL' };
        break;
      }
    }
  }
  if (!confirmation) {
    return {
      active: true,
      direction: gapDirection,
      status: gapDirection === 'DOWN' && sawCloseAboveEma21
        ? 'WAITING_FOR_RETURN_BELOW_EMA21'
        : 'WAITING_FOR_EMA21_BREAK',
      signal: 'WATCH',
      gapPct: Math.abs(gapPct)
    };
  }
  if (confirmation.index !== candles.length - 1) {
    return {
      active: true,
      direction: gapDirection,
      status: 'SETUP_EXPIRED',
      signal: 'WATCH',
      gapPct: Math.abs(gapPct)
    };
  }
  return {
    active: true,
    direction: gapDirection,
    status: 'CONFIRMED',
    signal: confirmation.signal,
    gapPct: Math.abs(gapPct)
  };
}

function calculateShortOptionRisk(entryPrice, tickSize, quantity, stopLossInr, targetInr) {
  quantity = Number(quantity);
  stopLossInr = Number(stopLossInr);
  targetInr = Number(targetInr);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(quantity) || quantity <= 0
    || !Number.isFinite(stopLossInr) || stopLossInr <= 0
    || !Number.isFinite(targetInr) || targetInr <= 0) {
    throw new Error('Configure positive stop loss and profit target amounts in INR before trading.');
  }
  if (targetInr >= entryPrice * quantity) {
    throw new Error('Profit target must be less than the option premium received for this position.');
  }
  const tick = Number(tickSize) || 0.05;
  const stopTicks = Math.ceil(((entryPrice + stopLossInr / quantity) / tick) - 1e-9);
  const targetTicks = Math.floor(((entryPrice - targetInr / quantity) / tick) + 1e-9);
  return {
    stopLossPrice: Number((stopTicks * tick).toFixed(2)),
    targetPrice: Number((Math.max(1, targetTicks) * tick).toFixed(2))
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
  const confirmed = confirmedSignal({
    crossedUp,
    crossedDown,
    trend,
    close: last.close,
    vwap,
    cpr
  });
  const gapSetup = getOpeningGapSetup(candles);
  const signal = gapSetup.active
    ? gapSetup.status === 'CONFIRMED' && gapSetup.signal === confirmed ? confirmed : 'WATCH'
    : confirmed;

  return {
    ema21: ema21Last,
    ema34: ema34Last,
    vwap,
    trend,
    signal,
    gapSetup,
    cpr,
    lastClose: last.close,
    lastCandleAt: new Date(last.timestamp * 1000).toISOString()
  };
}

function rankLiquidInstruments(instruments, quotes, minTurnover = 0) {
  return instruments.map((instrument) => {
    const quote = quotes.NSE_EQ?.[instrument.securityId];
    const volume = Number(quote?.volume);
    const averagePrice = Number(quote?.average_price);
    const lastPrice = Number(quote?.last_price);
    const turnover = Number.isFinite(volume) && volume > 0
      ? volume * (averagePrice > 0 ? averagePrice : Number.isFinite(lastPrice) ? lastPrice : 0)
      : 0;
    return { ...instrument, quote, turnover };
  }).filter((instrument) => Number.isFinite(instrument.turnover) && instrument.turnover >= minTurnover)
    .sort((left, right) => right.turnover - left.turnover || left.symbol.localeCompare(right.symbol));
}

async function getLiveScan(optionSecurityIds = []) {
  requireConnection();
  const instruments = await getEquityInstruments();
  const quotes = await getQuotes(instruments, optionSecurityIds);
  const liquidInstruments = rankLiquidInstruments(instruments, quotes);
  scheduleCandleRefresh(liquidInstruments);
  const rows = [];
  for (const [index, instrument] of liquidInstruments.entries()) {
    const price = Number(instrument.quote?.last_price);
    let indicators = null;
    let dataError = null;
    const candleRecord = candleCache.get(instrument.securityId);
    const candleAge = candleRecord ? Date.now() - candleRecord.fetchedAt : Infinity;
    if (candleRecord) {
      const cachedIndicators = indicatorCache.get(instrument.securityId);
      if (cachedIndicators?.fetchedAt === candleRecord.fetchedAt) indicators = cachedIndicators.value;
      else {
        indicators = calculateIndicators(candleRecord.candles);
        indicatorCache.set(instrument.securityId, { fetchedAt: candleRecord.fetchedAt, value: indicators });
      }
    }
    if (candleRefreshErrors.has(instrument.securityId)) dataError = candleRefreshErrors.get(instrument.securityId);
    else if (!candleRecord) dataError = 'Loading closed 15-minute candles';
    else if (candleAge >= 15 * 60 * 1000) dataError = 'Refreshing closed 15-minute candles';
    else if (!indicators) dataError = 'Not enough closed 15-minute candles';
    rows.push({
      symbol: instrument.symbol,
      securityId: instrument.securityId,
      timeframe: '15m',
      price: Number.isFinite(price) ? price : null,
      turnover: instrument.turnover,
      liquidityRank: index + 1,
      ema21: indicators?.ema21 ?? null,
      ema34: indicators?.ema34 ?? null,
      vwap: indicators?.vwap ?? null,
      cpr: indicators?.cpr || null,
      supertrend: indicators?.trend || 'UNAVAILABLE',
      signal: candleAge < 15 * 60 * 1000 ? (indicators?.signal || 'WATCH') : 'WATCH',
      trend: indicators?.trend || 'Unavailable',
      setup: indicators?.signal === 'BUY' ? 'SELL PUT' : indicators?.signal === 'SELL' ? 'SELL CALL'
        : indicators?.gapSetup?.active
          ? indicators.gapSetup.status === 'WAITING_FOR_EMA_BAND'
            ? `GAP ${indicators.gapSetup.direction} ${indicators.gapSetup.gapPct.toFixed(1)}% · WAIT EMA BAND`
            : indicators.gapSetup.status === 'WAITING_FOR_RETURN_BELOW_EMA21'
              ? `GAP DOWN ${indicators.gapSetup.gapPct.toFixed(1)}% · WAIT RETURN BELOW EMA21`
              : indicators.gapSetup.status === 'WAITING_FOR_EMA21_BREAK'
                ? `GAP ${indicators.gapSetup.direction} ${indicators.gapSetup.gapPct.toFixed(1)}% · WAIT EMA21 BREAK`
                : indicators.gapSetup.status === 'SETUP_EXPIRED'
                  ? `GAP ${indicators.gapSetup.direction} · WAIT NEXT SETUP`
                  : `GAP ${indicators.gapSetup.direction} · WAIT FULL CONFIRMATION`
          : 'WAIT',
      lastCandleAt: indicators?.lastCandleAt || null,
      dataError: !Number.isFinite(price) || price <= 0 ? 'Current cash quote unavailable' : dataError,
      dataState: !Number.isFinite(price) || price <= 0 ? 'UNAVAILABLE' : !candleRecord ? 'LOADING' : candleAge >= 15 * 60 * 1000 ? 'REFRESHING' : indicators ? 'READY' : 'UNAVAILABLE'
    });
  }
  return {
    results: rows,
    optionQuotes: quotes.NSE_FNO || {},
    scannedUniverse: instruments.length,
    liquidityThreshold: null,
    quotesUpdatedAt: quoteCache.fetchedAt ? new Date(quoteCache.fetchedAt).toISOString() : null
  };
}

module.exports = {
  connect,
  verifyConnection,
  getConnectionVerification,
  renewAccessToken,
  disconnect,
  getConnection,
  getPositions,
  getSuperOrders,
  getOrders,
  getFunds,
  checkOrderMargin,
  getLiveScan,
  createOptionOrderPreview,
  placeSuperOrder,
  requireConnection,
  chooseOptionExpiry,
  optionTargetForSignal,
  getOpeningGapSetup,
  rankLiquidInstruments,
  deriveFnoEquityInstruments,
  istDate,
  isEntryWindowOpen,
  calculatePreviousDayCpr,
  confirmedSignal,
  calculateShortOptionRisk,
  meetsOptionLiquidity
};
'use strict';
