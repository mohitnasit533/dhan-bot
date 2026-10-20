'use strict';

const express = require('express');
const path = require('path');
const { randomUUID } = require('node:crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const dhan = require('./dhan');
const { createDhanMcp } = require('./dhan-mcp');
const { isEntryWindowOpen } = dhan;
const { isAllowedLocalHost, isSameOriginRequest } = require('./local-security');
const {
  findActiveSuperOrder,
  findActiveRegularOrder,
  isActiveRegularOrder,
  countLiveExposure: countTrackedLiveExposure,
  isReconciledOrderTerminal
} = require('./live-order-guard');
const { createAutoSignalStore } = require('./auto-signal-store');
const { saveAccessToken, saveDhanCredentials } = require('./token-env-store');
const { createLocalStateStore } = require('./local-state-store');
const { createMarketSafety } = require('./market-safety');
const { createAppLogger } = require('./app-logger');
const { reviewLiveSquareOff } = require('./live-squareoff');
const {
  DEFAULT_SETTINGS,
  validateTradeSettings,
  missingRiskSettings,
  calculatePaperDailyPnl,
  calculateBotLiveDailyPnl,
  indiaDate,
  isSquareOffTime
} = require('./risk-controls');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';
const AUTO_SIGNAL_STATE_PATH = path.join(__dirname, '.dhan-auto-state.json');
const LOCAL_STATE_PATH = path.join(__dirname, '.dhan-local-state.json');
const MARKET_SAFETY_STATE_PATH = path.join(__dirname, '.dhan-market-safety.json');
const LOG_DIRECTORY = path.join(__dirname, '.dhan-logs');
const ENV_FILE_PATH = path.join(__dirname, '.env');
const DHAN_MCP_CALLBACK_URL = `http://${HOST}:${PORT}/api/mcp/callback`;
const TOKEN_RENEW_INTERVAL_MS = 20 * 60 * 60 * 1000;
const TOKEN_RETRY_INTERVAL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_TRADES = 5;
const MAX_CLOSED_TRADES = 1000;
const localStateStore = createLocalStateStore(LOCAL_STATE_PATH, DEFAULT_SETTINGS, validateTradeSettings);
const persistedState = localStateStore.getState();
const marketSafety = createMarketSafety({ statePath: MARKET_SAFETY_STATE_PATH });
const appLogger = createAppLogger(LOG_DIRECTORY);
const dhanMcp = createDhanMcp({ redirectUrl: DHAN_MCP_CALLBACK_URL });
let tradingMode = 'PAPER';
let tokenRenewalTimer = null;
let tokenRenewalStatus = { enabled: false, message: 'Add Dhan credentials to .env to enable automatic token renewal.' };

app.use(helmet({
  hsts: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  if (!isAllowedLocalHost(req.headers.host)) {
    return res.status(403).json({ ok: false, message: 'This dashboard accepts requests from localhost only.' });
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ ok: false, message: 'Cross-site requests are not allowed.' });
    }
    const origin = req.get('origin');
    if (origin) {
      if (!isSameOriginRequest(origin, req.headers.host)) {
        return res.status(403).json({ ok: false, message: 'Cross-origin requests are not allowed.' });
      }
    }
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const tradeMutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});
app.use('/api/trade', tradeMutationLimiter);

let allowedSymbols = new Set();
const activeTrades = new Map(persistedState.activeTrades.map((trade) => [trade.symbol, trade]));
const closedTrades = [...persistedState.closedTrades];
const liveTrades = [...persistedState.liveTrades];
const orderPreviews = new Map();
const autoSignalStore = createAutoSignalStore(AUTO_SIGNAL_STATE_PATH);
const lastAutoSignals = autoSignalStore.signals;
const liveSubmissionLocks = new Map(persistedState.liveTrades
  .filter((trade) => trade.status !== 'CLOSED')
  .map((trade) => [trade.symbol, {
    correlationId: trade.correlationId || null,
    orderId: trade.orderId || null,
    state: 'uncertain'
  }]));
const autoTradeConfig = {
  enabled: false,
  settings: persistedState.settings,
  lastError: null
};

let persistenceFailure = null;
function saveLocalState() {
  try {
    localStateStore.save({
      settings: autoTradeConfig.settings,
      activeTrades: getActiveTradesList().filter((trade) => trade.status === 'OPEN'),
      closedTrades,
      liveTrades
    });
    persistenceFailure = null;
  } catch (error) {
    persistenceFailure = error.message;
    throw error;
  }
}

function getPaperDailyPnl() {
  return calculatePaperDailyPnl(getActiveTradesList(), closedTrades);
}

function getDailyPnl(brokerPositions) {
  const livePositions = tradingMode === 'LIVE'
    ? brokerPositions ?? marketSnapshot?.brokerPositions ?? []
    : [];
  return getPaperDailyPnl() + calculateBotLiveDailyPnl(liveTrades, livePositions);
}

async function notify(level, message, details = {}) {
  try {
    await appLogger.alert(level, message, details);
  } catch (error) {
    autoTradeConfig.lastError = `Alert/logging failed: ${error.message}`;
    console.error(autoTradeConfig.lastError);
  }
}

const rememberAutoSignal = autoSignalStore.remember;

function recordClosedTrade(trade) {
  closedTrades.push({ ...trade });
  const removedTrade = closedTrades.length > MAX_CLOSED_TRADES ? closedTrades.shift() : null;
  try {
    saveLocalState();
  } catch (error) {
    closedTrades.pop();
    if (removedTrade) closedTrades.unshift(removedTrade);
    throw error;
  }
}

function getActiveTradesList() {
  return Array.from(activeTrades.values());
}

function saveRenewedToken(accessToken) {
  saveAccessToken(ENV_FILE_PATH, accessToken);
  process.env.DHAN_ACCESS_TOKEN = accessToken;
}

function scheduleTokenRenewal(delayMs, retriesRemaining = 2) {
  if (tokenRenewalTimer) clearTimeout(tokenRenewalTimer);
  tokenRenewalTimer = setTimeout(() => renewConfiguredToken(retriesRemaining), delayMs);
  tokenRenewalTimer.unref();
}

async function renewConfiguredToken(retriesRemaining = 2) {
  try {
    const renewed = await dhan.renewAccessToken();
    saveRenewedToken(renewed.accessToken);
    tokenRenewalStatus = {
      enabled: true,
      message: 'Automatic renewal active. Dhan access token saved locally.',
      expiryTime: renewed.expiryTime,
      renewedAt: new Date().toISOString()
    };
    console.log('Dhan access token renewed and saved to the local .env file.');
    scheduleTokenRenewal(TOKEN_RENEW_INTERVAL_MS);
  } catch (error) {
    tokenRenewalStatus = {
      enabled: false,
      message: `Automatic renewal failed: ${error.message} Dhan Web tokens are valid for 24 hours; enter a fresh active token in .env if renewal is unavailable.`,
      failedAt: new Date().toISOString()
    };
    console.error(tokenRenewalStatus.message);
    if (retriesRemaining > 0) scheduleTokenRenewal(TOKEN_RETRY_INTERVAL_MS, retriesRemaining - 1);
  }
}

function createPaperTrade(preview) {
  const actionText = preview.preview.Action || 'SELL PE';
  const optionType = actionText.split(' ')[1] || 'PE';

  const trade = {
    symbol: preview.symbol,
    signal: preview.signal,
    side: `SELL ${optionType}`,
    optionType,
    securityId: preview.order.securityId,
    tickSize: preview.tickSize,
    strike: preview.preview.Strike,
    expiry: preview.preview.Expiry,
    lotSize: preview.lots,
    quantity: preview.order.quantity,
    entryPrice: preview.order.price,
    currentPrice: preview.order.price,
    stopPrice: preview.order.stopLossPrice,
    targetPrice: preview.order.targetPrice,
    riskUnit: preview.risk.unit,
    stopLossValue: preview.risk.stopLossValue,
    targetValue: preview.risk.targetValue,
    status: 'OPEN',
    openedAt: new Date().toISOString(),
    pnlPct: 0,
    pnlInr: 0,
    entryType: preview.entryType || 'MANUAL'
  };
  activeTrades.set(preview.symbol, trade);
  try {
    saveLocalState();
  } catch (error) {
    activeTrades.delete(preview.symbol);
    throw error;
  }
  return trade;
}

function positionMatchesUnderlying(position, symbol) {
  const instrumentName = String(position.tradingSymbol || position.securityName || '').toUpperCase();
  return instrumentName === symbol || instrumentName.startsWith(`${symbol}-`) || instrumentName.startsWith(`${symbol} `);
}

function syncBotLiveTrades(positions) {
  let changed = false;
  for (const trade of liveTrades) {
    if (indiaDate(new Date(trade.openedAt)) !== indiaDate()) continue;
    const position = positions.find((item) => String(item.securityId) === String(trade.securityId));
    if (!position) continue;
    const realized = Number(position.realizedProfit ?? position.realisedProfit ?? 0);
    const unrealized = Number(position.unrealizedProfit ?? position.unrealisedProfit ?? 0);
    if (!Number.isFinite(realized) || !Number.isFinite(unrealized)) continue;
    const pnl = realized + unrealized;
    if (trade.lastPnlInr !== pnl) {
      trade.lastPnlInr = pnl;
      changed = true;
    }
    if (Number(position.netQty) === 0 && trade.status !== 'CLOSED') {
      trade.status = 'CLOSED';
      trade.closedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveLocalState();
}

function syncPaperTrades(optionQuotes) {
  for (const trade of getActiveTradesList()) {
    const previousTrade = { ...trade };
    const currentPrice = Number(optionQuotes[trade.securityId]?.last_price);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      const priorAlertTime = Date.parse(trade.eodSquareOffQuoteAlertedAt || '');
      const alertedToday = Number.isFinite(priorAlertTime)
        && indiaDate(new Date(priorAlertTime)) === indiaDate();
      if (isSquareOffTime() && !alertedToday) {
        trade.eodSquareOffQuoteAlertedAt = new Date().toISOString();
        const message = `${trade.symbol}: no valid option quote was available at the 14:58 IST Paper square-off. The simulated position remains open.`;
        autoTradeConfig.lastError = message;
        saveLocalState();
        void notify('critical', message, { symbol: trade.symbol, securityId: trade.securityId });
      }
      continue;
    }

    trade.currentPrice = currentPrice;

    const pnlPct = ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100;

    trade.pnlPct = pnlPct;
    trade.pnlInr = (trade.entryPrice - currentPrice) * trade.quantity;

    const stopTriggered = Number(trade.stopPrice) > 0 && currentPrice >= Number(trade.stopPrice);
    const targetTriggered = Number(trade.targetPrice) > 0 && currentPrice <= Number(trade.targetPrice);
    const endOfDay = isSquareOffTime() && !stopTriggered && !targetTriggered;
    const shouldClose = stopTriggered || targetTriggered || endOfDay;
    if (shouldClose) {
      trade.status = 'CLOSED';
      trade.exitReason = stopTriggered ? 'STOP_LOSS' : targetTriggered ? 'TARGET' : 'END_OF_DAY';
      trade.exitPrice = currentPrice;
      trade.closedAt = new Date().toISOString();
      try {
        recordClosedTrade(trade);
        activeTrades.delete(trade.symbol);
      } catch (error) {
        Object.assign(trade, previousTrade);
        throw error;
      }
      void notify('info', endOfDay && !stopTriggered && !targetTriggered
        ? 'Paper position closed at the scheduled 14:58 IST square-off.'
        : 'Paper position closed by its configured risk exit.', {
        symbol: trade.symbol,
        exitReason: trade.exitReason,
        pnlInr: Number(trade.pnlInr.toFixed(2))
      });
    }
  }
}

async function runPaperAutoTrades(results) {
  if (!isEntryWindowOpen()) return;
  for (const result of results) {
    if (!autoTradeConfig.enabled) return;
    if (result.signal !== 'BUY' && result.signal !== 'SELL') {
      continue;
    }

    const signalKey = `${result.lastCandleAt || 'unknown'}:${result.signal}`;
    if (activeTrades.has(result.symbol)) {
      try { rememberAutoSignal(result.symbol, signalKey); } catch (error) {
        autoTradeConfig.lastError = `Could not save auto-trade duplicate protection: ${error.message}`;
      }
      continue;
    }
    if (activeTrades.size >= autoTradeConfig.settings.maxTrades) continue;

    try {
      await marketSafety.assertCanTrade(result.symbol);
      const orderPreview = await dhan.createOptionOrderPreview({
        symbol: result.symbol,
        signal: result.signal,
        lots: autoTradeConfig.settings.lotSize,
        includeMargin: false,
        riskSettings: autoTradeConfig.settings
      });
      if (!autoTradeConfig.enabled || tradingMode !== 'PAPER' || !dhan.getConnection()) return;
      const latestScan = await dhan.getLiveScan(getActiveTradesList().map((trade) => trade.securityId));
      const latest = latestScan.results.find((row) => row.symbol === result.symbol);
      if (!autoTradeConfig.enabled || tradingMode !== 'PAPER' || !dhan.getConnection()) return;
      if (latest?.signal !== result.signal || latest?.lastCandleAt !== result.lastCandleAt || latest?.dataState !== 'READY') continue;
      syncPaperTrades(latestScan.optionQuotes);
      if (activeTrades.has(result.symbol) || activeTrades.size >= autoTradeConfig.settings.maxTrades) continue;
      if (!rememberAutoSignal(result.symbol, signalKey)) continue;
      createPaperTrade({ ...orderPreview, symbol: result.symbol, lots: autoTradeConfig.settings.lotSize, entryType: 'AUTO' });
      void notify('info', 'Paper position opened by a confirmed signal.', {
        symbol: result.symbol,
        signal: result.signal,
        lots: autoTradeConfig.settings.lotSize
      });
      autoTradeConfig.lastError = null;
    } catch (error) {
      autoTradeConfig.lastError = `${result.symbol}: ${error.message}`;
    }
  }
}

function countLiveExposure(positions, superOrders, regularOrders = []) {
  return countTrackedLiveExposure(positions, superOrders, regularOrders, liveSubmissionLocks, allowedSymbols);
}

async function runLiveAutoTrades(results, positions, superOrders, regularOrders) {
  if (!autoTradeConfig.enabled || tradingMode !== 'LIVE' || !dhan.getConnection() || !isEntryWindowOpen()) return;

  for (const result of results) {
    if (!autoTradeConfig.enabled || tradingMode !== 'LIVE' || !dhan.getConnection()) return;
    if (result.dataState !== 'READY' || !['BUY', 'SELL'].includes(result.signal)) continue;
    const signalKey = `${result.lastCandleAt || 'unknown'}:${result.signal}`;
    if (lastAutoSignals.get(result.symbol) === signalKey) continue;
    if (positions.some((position) => positionMatchesUnderlying(position, result.symbol))
      || findActiveSuperOrder(superOrders, result.symbol)
      || findActiveRegularOrder(regularOrders, result.symbol)
      || liveSubmissionLocks.has(result.symbol)) {
      try { rememberAutoSignal(result.symbol, signalKey); } catch (error) {
        autoTradeConfig.lastError = `Could not save auto-trade duplicate protection: ${error.message}`;
      }
      continue;
    }
    if (countLiveExposure(positions, superOrders, regularOrders) >= autoTradeConfig.settings.maxTrades) continue;
    const reservation = { correlationId: null, state: 'preparing' };
    liveSubmissionLocks.set(result.symbol, reservation);
    let orderSubmissionAttempted = false;
    try {
      await marketSafety.assertCanTrade(result.symbol);
      const preview = await dhan.createOptionOrderPreview({
        symbol: result.symbol,
        signal: result.signal,
        lots: autoTradeConfig.settings.lotSize,
        riskSettings: autoTradeConfig.settings
      });
      const orderNotional = Number(preview.preview['Order notional']);
      if (orderNotional > 50000) {
        liveSubmissionLocks.delete(result.symbol);
        autoTradeConfig.lastError = `${result.symbol}: auto Live order skipped because estimated notional exceeds INR 50,000. Reduce lots or use manual preview.`;
        continue;
      }
      if (!autoTradeConfig.enabled || tradingMode !== 'LIVE' || !dhan.getConnection() || !isEntryWindowOpen()) {
        liveSubmissionLocks.delete(result.symbol);
        continue;
      }

      const latestScan = await dhan.getLiveScan();
      const latest = latestScan.results.find((row) => row.symbol === result.symbol);
      if (latest?.signal !== result.signal || latest?.lastCandleAt !== result.lastCandleAt || latest.dataState !== 'READY') {
        liveSubmissionLocks.delete(result.symbol);
        continue;
      }

      const [currentPositions, currentOrders, currentRegularOrders] = await Promise.all([
        dhan.getPositions(),
        dhan.getSuperOrders(),
        dhan.getOrders()
      ]);
      const currentOpenPositions = currentPositions.filter((position) => Number(position.netQty) !== 0);
      if (currentOpenPositions.some((position) => positionMatchesUnderlying(position, result.symbol))
        || findActiveSuperOrder(currentOrders, result.symbol)
        || findActiveRegularOrder(currentRegularOrders, result.symbol)) {
        liveSubmissionLocks.delete(result.symbol);
        continue;
      }
      if (countLiveExposure(currentPositions, currentOrders, currentRegularOrders) > autoTradeConfig.settings.maxTrades) {
        liveSubmissionLocks.delete(result.symbol);
        continue;
      }
      if (!autoTradeConfig.enabled || tradingMode !== 'LIVE' || !dhan.getConnection() || !isEntryWindowOpen()) {
        liveSubmissionLocks.delete(result.symbol);
        continue;
      }
      await marketSafety.assertCanTrade(result.symbol);
      const margin = await dhan.checkOrderMargin(preview.order);
      if (!autoTradeConfig.enabled || tradingMode !== 'LIVE' || !dhan.getConnection() || !isEntryWindowOpen()) {
        liveSubmissionLocks.delete(result.symbol);
        continue;
      }

      if (!rememberAutoSignal(result.symbol, signalKey)) {
        liveSubmissionLocks.delete(result.symbol);
        continue;
      }
      reservation.correlationId = preview.order.correlationId;
      const liveTrade = {
        symbol: result.symbol,
        securityId: preview.order.securityId,
        tickSize: preview.tickSize,
        entryPrice: preview.order.price,
        quantity: preview.order.quantity,
        openedAt: new Date().toISOString(),
        status: 'SUBMITTING',
        lastPnlInr: 0,
        correlationId: preview.order.correlationId
      };
      liveTrades.push(liveTrade);
      try {
        saveLocalState();
      } catch (error) {
        liveTrades.pop();
        throw error;
      }
      reservation.state = 'submitting';
      orderSubmissionAttempted = true;
      const response = await dhan.placeSuperOrder(preview.order);
      const orderData = response.data || response;
      reservation.orderId = orderData.orderId || orderData.order_id || null;
      reservation.state = 'submitted';
      liveTrade.status = 'SUBMITTED';
      liveTrade.orderId = reservation.orderId;
      saveLocalState();
      void notify('warning', 'Confirmed signal submitted as a live Dhan order.', {
        symbol: result.symbol,
        orderId: reservation.orderId || 'pending',
        estimatedMargin: margin.totalMargin,
        availableFunds: margin.availableFunds
      });
      autoTradeConfig.lastError = null;
    } catch (error) {
      if (orderSubmissionAttempted) reservation.state = 'uncertain';
      else liveSubmissionLocks.delete(result.symbol);
      autoTradeConfig.lastError = `${result.symbol}: ${error.message}`;
    }
  }
}

let latestLiveAutoSnapshot = null;
let liveAutoQueueRunning = false;
function scheduleLiveAutoTrades(results, positions, superOrders, regularOrders) {
  latestLiveAutoSnapshot = { results, positions, superOrders, regularOrders };
  if (liveAutoQueueRunning) return;
  liveAutoQueueRunning = true;
  setImmediate(async () => {
    try {
      while (latestLiveAutoSnapshot) {
        const snapshot = latestLiveAutoSnapshot;
        latestLiveAutoSnapshot = null;
        await runLiveAutoTrades(snapshot.results, snapshot.positions, snapshot.superOrders, snapshot.regularOrders);
      }
    } catch (error) {
      autoTradeConfig.lastError = error.message;
    } finally {
      liveAutoQueueRunning = false;
      if (latestLiveAutoSnapshot) scheduleLiveAutoTrades(
        latestLiveAutoSnapshot.results,
        latestLiveAutoSnapshot.positions,
        latestLiveAutoSnapshot.superOrders,
        latestLiveAutoSnapshot.regularOrders
      );
    }
  });
}

let marketCyclePromise = null;
let marketSnapshot = null;
async function reviewTrackedLiveSquareOff(positions, superOrders, regularOrders, optionQuotes) {
  const profile = dhan.getConnection();
  if (!profile) return;
  for (const trade of liveTrades) {
    if (trade.status === 'CLOSED') continue;
    const position = positions.find((item) => String(item.securityId) === String(trade.securityId));
    try {
      const result = await reviewLiveSquareOff({
        trade,
        position,
        superOrders,
        regularOrders,
        optionQuote: optionQuotes?.[trade.securityId],
        broker: {
          clientId: profile.clientId,
          cancelSuperOrderLeg: dhan.cancelSuperOrderLeg,
          cancelRegularOrder: dhan.cancelRegularOrder,
          placeRegularOrder: dhan.placeRegularOrder
        },
        save: saveLocalState,
        notify
      });
      if (trade.eodExitLastError) {
        autoTradeConfig.lastError = `${trade.symbol}: ${trade.eodExitLastError}`;
      } else if (result.action.startsWith('SUBMITTED_') || result.action === 'POSITION_ALREADY_FLAT') {
        autoTradeConfig.lastError = null;
      }
      if (result.action === 'SUBMITTED_LIMIT' || result.action === 'SUBMITTED_MARKET') {
        void notify('warning', `Scheduled ${result.action.endsWith('LIMIT') ? 'LIMIT' : 'MARKET'} square-off order submitted for a bot-tracked Live position.`, {
          symbol: trade.symbol,
          orderId: result.orderId || 'pending reconciliation',
          quantity: trade.eodExitQuantity
        });
      }
    } catch (error) {
      autoTradeConfig.lastError = `${trade.symbol}: Live square-off could not be persisted or reconciled: ${error.message}`;
      await notify('critical', autoTradeConfig.lastError, { symbol: trade.symbol, securityId: trade.securityId });
    }
  }
}

async function updateMarketSnapshot() {
  if (marketCyclePromise) return marketCyclePromise;
  const cycle = (async () => {
    const optionIds = [...getActiveTradesList(), ...liveTrades.filter((trade) => trade.status !== 'CLOSED')]
      .map((trade) => trade.securityId);
    const scan = await dhan.getLiveScan(optionIds);
    allowedSymbols = new Set(scan.results.map((row) => row.symbol));
    syncPaperTrades(scan.optionQuotes);
    const shouldCheckBrokerPositions = tradingMode === 'LIVE'
      || liveTrades.some((trade) => trade.status !== 'CLOSED');
    let positions = [];
    let superOrders = [];
    let regularOrders = [];
    if (shouldCheckBrokerPositions) {
      [positions, superOrders, regularOrders] = await Promise.all([
        dhan.getPositions(),
        dhan.getSuperOrders(),
        dhan.getOrders()
      ]);
      syncBotLiveTrades(positions);
      await reviewTrackedLiveSquareOff(positions, superOrders, regularOrders, scan.optionQuotes);
      for (const [symbol, reservation] of liveSubmissionLocks) {
        if (isReconciledOrderTerminal(superOrders, regularOrders, reservation)) liveSubmissionLocks.delete(symbol);
      }
    }
    if (tradingMode === 'PAPER') {
      if (autoTradeConfig.enabled) await runPaperAutoTrades(scan.results);
      marketSnapshot = { scan, brokerPositions: [], activePositions: getActiveTradesList() };
    } else {
      const brokerPositions = positions.filter((position) => Number(position.netQty) !== 0);
      if (autoTradeConfig.enabled) scheduleLiveAutoTrades(scan.results, positions, superOrders, regularOrders);
      marketSnapshot = { scan, brokerPositions, activePositions: [] };
    }
    return marketSnapshot;
  })();
  marketCyclePromise = cycle;
  try {
    return await cycle;
  } finally {
    if (marketCyclePromise === cycle) marketCyclePromise = null;
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'dhan-local-dashboard', timestamp: new Date().toISOString() });
});

app.get('/api/mcp/status', (req, res) => {
  const status = dhanMcp.getStatus();
  res.json({
    ok: true,
    ...status,
    scannerUsesMcp: false,
    message: status.connected
      ? 'Dhan MCP is authorized and its tool catalog is available. Scanner data remains on the verified Dhan API until compatible read-only market-data tools are validated.'
      : 'Dhan MCP is not connected. Connect to authorize and inspect its tools.'
  });
});

app.post('/api/mcp/connect', rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
}), async (req, res) => {
  try {
    const status = await dhanMcp.connect();
    res.json({ ok: true, ...status });
  } catch (error) {
    appLogger.write('error', 'Dhan MCP connection failed', {
      errorName: error?.name || 'Error',
      statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : null
    });
    res.status(502).json({
      ok: false,
      message: 'Could not connect to Dhan MCP. Check the network and try again; no trading action was submitted.'
    });
  }
});

app.get('/api/mcp/callback', async (req, res) => {
  try {
    const callbackUrl = new URL(req.originalUrl, `http://${HOST}`);
    await dhanMcp.finishAuthorization(callbackUrl.searchParams);
    res.redirect('/?dhanMcp=connected');
  } catch (error) {
    appLogger.write('error', 'Dhan MCP authorization callback failed', {
      errorName: error?.name || 'Error',
      statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : null
    });
    res.redirect('/?dhanMcp=failed');
  }
});

app.post('/api/mcp/market-data', async (req, res) => {
  try {
    const result = await dhanMcp.callMarketData(req.body?.action, req.body?.payload);
    res.json({ ok: true, result });
  } catch (error) {
    const statusCode = /Connect and authorize|Unsupported MCP market-data action|payload|tool schema|security IDs|exchange segment|does not expose/i.test(error.message)
      ? 409
      : Number(error.statusCode) || 502;
    appLogger.write('error', 'Dhan MCP market-data request failed', {
      errorName: error?.name || 'Error',
      statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : null
    });
    res.status(statusCode).json({
      ok: false,
      message: statusCode === 409
        ? error.message
        : 'Dhan MCP market-data request failed. No trading or order action was submitted.'
    });
  }
});

app.post('/api/mcp/disconnect', (req, res) => {
  dhanMcp.disconnect();
  res.json({
    ok: true,
    ...dhanMcp.getStatus(),
    message: 'Dhan MCP credentials were removed from this server’s memory. Dhan API credentials and trading mode are unchanged.'
  });
});

function suspendAutoTrade(reason) {
  if (!autoTradeConfig.enabled) return;
  autoTradeConfig.enabled = false;
  autoTradeConfig.lastError = reason;
  try {
    saveLocalState();
  } catch (error) {
    autoTradeConfig.lastError += ` Local state save failed: ${error.message}`;
  }
  void notify('critical', `Automatic trading was stopped: ${autoTradeConfig.lastError}`);
}

app.get('/api/connection', async (req, res) => {
  let profile = null;
  let verificationError = null;
  if (dhan.getConnection()) {
    try {
      profile = await dhan.verifyConnection();
    } catch (error) {
      verificationError = error.message;
      suspendAutoTrade(`Dhan profile verification failed: ${error.message}`);
    }
  }
  const dailyPnlInr = getDailyPnl(marketSnapshot?.brokerPositions || []);
  res.json({
    ok: true,
    connected: Boolean(profile),
    profile,
    verification: {
      verified: Boolean(profile),
      checkedAt: dhan.getConnectionVerification().verifiedAt,
      error: verificationError
    },
    mode: tradingMode,
    tokenRenewal: tokenRenewalStatus,
    autoTrade: autoTradeConfig.enabled,
    settings: autoTradeConfig.settings,
    riskReady: missingRiskSettings(autoTradeConfig.settings).length === 0,
    missingRiskSettings: missingRiskSettings(autoTradeConfig.settings),
    dailyPnlInr,
    marketSafety: marketSafety.getStatus(),
    persistenceError: persistenceFailure
  });
});

app.post('/api/connection/register-ip', rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
}), async (req, res) => {
  if (!dhan.getConnection()) {
    return res.status(401).json({ ok: false, message: 'Connect and verify Dhan before requesting IP registration.' });
  }
  try {
    await dhan.verifyConnection();
    const { ip, ipFlag } = req.body || {};
    await dhan.setStaticIp(ip, ipFlag);
    appLogger.write('info', 'Dhan static IP registration accepted', { ipFlag });
    res.json({
      ok: true,
      message: `Dhan accepted the ${ipFlag} static-IP registration. Verify the address in your Dhan account before placing live orders.`
    });
  } catch (error) {
    appLogger.write('error', 'Dhan current-network IP registration failed', {
      errorName: error?.name || 'Error',
      statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : null
    });
    res.status(error.statusCode || 502).json({
      ok: false,
      message: 'Dhan did not confirm IP registration. Check your API permissions, account settings, and network before trying again.'
    });
  }
});

app.post('/api/connect', rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
}), async (req, res) => {
  try {
    const profile = await dhan.connect(req.body?.clientId, req.body?.accessToken);
  let persistenceMessage = '';
  if (req.body?.rememberCredentials === true) {
    try {
      const clientId = String(req.body.clientId).trim();
      const accessToken = String(req.body.accessToken).trim();
      saveDhanCredentials(ENV_FILE_PATH, clientId, accessToken);
      process.env.DHAN_CLIENT_ID = clientId;
      process.env.DHAN_ACCESS_TOKEN = accessToken;
    } catch (error) {
      tokenRenewalStatus = { enabled: false, message: 'Verified credentials remain in memory only; local .env save failed.' };
      persistenceMessage = ` Credentials were verified but could not be saved locally: ${error.message}`;
    }
  }
  if (!persistenceMessage
    && process.env.DHAN_CLIENT_ID?.trim() === String(req.body?.clientId || '').trim()
    && process.env.DHAN_ACCESS_TOKEN?.trim() === String(req.body?.accessToken || '').trim()) {
    tokenRenewalStatus = { enabled: true, message: 'Dhan token connected. Automatic renewal is starting.' };
    renewConfiguredToken();
  } else if (!persistenceMessage) {
    tokenRenewalStatus = {
      enabled: false,
      message: 'Credentials are held in server memory only; select local saving to enable automatic renewal.'
    };
  }
    res.json({
      ok: true,
      connected: true,
      profile,
      mode: tradingMode,
      tokenRenewal: tokenRenewalStatus,
      autoTrade: autoTradeConfig.enabled,
      settings: autoTradeConfig.settings,
      message: tokenRenewalStatus.enabled
        ? `Connected to Dhan as ${profile.name}. Automatic token renewal is enabled.${persistenceMessage}`
        : `Connected to Dhan as ${profile.name}. ${persistenceMessage || 'Credentials are held in server memory only.'}`
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, connected: false, message: error.message });
  }
});

app.post('/api/disconnect', (req, res) => {
  if (Array.from(liveSubmissionLocks.values()).some((reservation) => reservation.state === 'submitting')) {
    return res.status(409).json({ ok: false, message: 'A live order submission is in progress. Wait for its broker response before disconnecting.' });
  }
  if (tokenRenewalTimer) clearTimeout(tokenRenewalTimer);
  tokenRenewalTimer = null;
  tokenRenewalStatus = { enabled: false, message: 'Dhan account disconnected.' };
  dhan.disconnect();
  tradingMode = 'PAPER';
  autoTradeConfig.enabled = false;
  latestLiveAutoSnapshot = null;
  liveSubmissionLocks.clear();
  marketSnapshot = null;
  orderPreviews.clear();
  res.json({ ok: true, connected: false, mode: tradingMode, message: 'Dhan disconnected. Trading mode returned to Paper.' });
});

app.post('/api/mode', async (req, res) => {
  const mode = req.body?.mode;
  if (mode !== 'PAPER' && mode !== 'LIVE') {
    return res.status(400).json({ ok: false, message: 'Mode must be PAPER or LIVE.' });
  }
  if (mode === 'LIVE' && autoTradeConfig.enabled) {
    const missing = missingRiskSettings(autoTradeConfig.settings);
    if (missing.length) {
      return res.status(409).json({ ok: false, message: `Configure these trade controls before switching Auto trade to Live: ${missing.join(', ')}.` });
    }
  }
  if (mode === 'LIVE' && !dhan.getConnection()) {
    return res.status(409).json({ ok: false, message: 'Connect and verify your Dhan account before enabling Live mode.' });
  }
  if (mode === 'LIVE') {
    try {
      await dhan.verifyConnection();
    } catch (error) {
      return res.status(401).json({ ok: false, message: `Dhan profile verification failed: ${error.message}` });
    }
  }
  if (mode !== tradingMode
    && Array.from(liveSubmissionLocks.values()).some((reservation) => reservation.state === 'submitting')) {
    return res.status(409).json({ ok: false, message: 'A live order submission is in progress. Wait for its broker response before changing modes.' });
  }

  if (tradingMode !== mode) orderPreviews.clear();
  tradingMode = mode;
  res.json({ ok: true, mode: tradingMode, message: mode === 'LIVE'
    ? 'Live mode enabled. Manual orders need confirmation; Live Auto trade places real orders automatically when enabled.'
    : 'Paper mode enabled. Confirmed signals will be simulated.' });
});

app.get('/api/account', async (req, res) => {
  if (!dhan.getConnection()) {
    return res.status(401).json({ ok: false, message: 'Connect a Dhan account first.' });
  }
  try {
    const [positions, funds] = await Promise.all([dhan.getPositions(), dhan.getFunds()]);
    res.json({ ok: true, positions, funds });
  } catch (error) {
    res.status(error.statusCode || 502).json({ ok: false, message: error.message });
  }
});

app.get('/api/scanner', async (req, res) => {
  if (!dhan.getConnection()) {
    const paperAutoWaiting = tradingMode === 'PAPER' && autoTradeConfig.enabled;
    const paperMissingRisk = paperAutoWaiting ? missingRiskSettings(autoTradeConfig.settings) : [];
    return res.json({
      ok: true,
      connected: false,
      mode: tradingMode,
      liveData: false,
      results: [],
      activePositions: getActiveTradesList(),
      brokerPositions: [],
      message: paperAutoWaiting
        ? `Paper Auto trade is enabled and waiting for verified Dhan market data${paperMissingRisk.length ? ` and saved risk controls (${paperMissingRisk.join(', ')})` : ''}. No simulated trades can open yet.`
        : 'Connect Dhan to load live market data.',
      autoTrade: {
        enabled: autoTradeConfig.enabled,
        mode: tradingMode,
        status: paperAutoWaiting
          ? paperMissingRisk.length ? 'paper_waiting_for_risk_and_market_data' : 'paper_waiting_for_market_data'
          : 'ready',
        lastError: autoTradeConfig.lastError || null
      }
    });
  }

  try {
    const snapshot = await updateMarketSnapshot();
    const scan = snapshot.scan;
    res.json({
      ok: true,
      connected: true,
      mode: tradingMode,
      liveData: true,
      results: scan.results,
      maxTrades: MAX_ACTIVE_TRADES,
      strategy: `15m EMA 21/34 crossover + Supertrend + VWAP + narrow CPR breakout; ${scan.results.length} current NSE stock F&O underlyings`,
      quotesUpdatedAt: scan.quotesUpdatedAt,
      activePositions: snapshot.activePositions,
      brokerPositions: snapshot.brokerPositions,
      closedPositions: closedTrades,
      runningPnlInr: tradingMode === 'PAPER'
        ? getActiveTradesList().reduce((total, trade) => total + Number(trade.pnlInr || 0), 0)
        : snapshot.brokerPositions.reduce((total, position) => total + Number(position.unrealizedProfit ?? position.unrealisedProfit ?? 0), 0),
      marketSafety: marketSafety.getStatus(),
      riskReady: missingRiskSettings(autoTradeConfig.settings).length === 0,
      missingRiskSettings: missingRiskSettings(autoTradeConfig.settings),
      autoTrade: {
        enabled: autoTradeConfig.enabled,
        mode: tradingMode,
        status: autoTradeConfig.enabled && tradingMode === 'LIVE'
          ? 'live_auto_enabled'
          : autoTradeConfig.enabled && missingRiskSettings(autoTradeConfig.settings).length
            ? 'paper_waiting_for_risk_settings'
            : 'ready',
        lastError: autoTradeConfig.lastError || null
      }
    });
  } catch (error) {
    res.status(error.statusCode || 502).json({ ok: false, connected: true, mode: tradingMode, message: error.message });
  }
});

app.post('/api/trade/preview', async (req, res) => {
  if (!dhan.getConnection()) return res.status(401).json({ ok: false, message: 'Connect Dhan before creating an order preview.' });
  if (!isEntryWindowOpen()) return res.status(409).json({ ok: false, message: 'New entries are allowed only on weekdays from 09:45 to before 14:00 IST.' });

  const requestedMode = tradingMode;
  const { symbol, signal } = req.body || {};
  const lots = Number(req.body?.lots);
  if (typeof symbol !== 'string' || !allowedSymbols.has(symbol) || !['BUY', 'SELL'].includes(signal)) {
    return res.status(400).json({ ok: false, message: 'Choose a supported symbol with a BUY or SELL scanner signal.' });
  }
  if (tradingMode === 'PAPER' && activeTrades.has(symbol)) {
    return res.status(409).json({ ok: false, message: `${symbol} already has a paper position open.` });
  }
  if (tradingMode === 'PAPER' && activeTrades.size >= autoTradeConfig.settings.maxTrades) {
    return res.status(409).json({ ok: false, message: `The configured maximum of ${autoTradeConfig.settings.maxTrades} paper positions has been reached.` });
  }

  try {
    await marketSafety.assertCanTrade(symbol);
    const scan = await dhan.getLiveScan(getActiveTradesList().map((trade) => trade.securityId));
    if (tradingMode !== requestedMode || !dhan.getConnection()) {
      return res.status(409).json({ ok: false, message: 'Connection or trading mode changed while preparing this preview. Try again.' });
    }
    if (tradingMode === 'PAPER') {
      syncPaperTrades(scan.optionQuotes);
    }
    const signalRow = scan.results.find((item) => item.symbol === symbol);
    if (!signalRow || signalRow.signal !== signal) {
      return res.status(409).json({ ok: false, message: 'The confirmed 15-minute signal has changed. Refresh the scanner before previewing.' });
    }

    if (tradingMode === 'LIVE') {
      const [positions, superOrders, regularOrders] = await Promise.all([
        dhan.getPositions(),
        dhan.getSuperOrders(),
        dhan.getOrders()
      ]);
      const openPositions = positions.filter((position) => Number(position.netQty) !== 0);
      if (liveSubmissionLocks.has(symbol)) {
        return res.status(409).json({ ok: false, message: `${symbol} already has a live order being reconciled. Check Dhan before trying again.` });
      }
      if (openPositions.some((position) => positionMatchesUnderlying(position, symbol))
        || findActiveSuperOrder(superOrders, symbol)
        || findActiveRegularOrder(regularOrders, symbol)) {
        return res.status(409).json({ ok: false, message: `${symbol} already has an open Dhan position or pending order.` });
      }
      if (countLiveExposure(positions, superOrders, regularOrders) >= autoTradeConfig.settings.maxTrades) {
        return res.status(409).json({ ok: false, message: `The configured maximum of ${autoTradeConfig.settings.maxTrades} live positions has been reached.` });
      }
    }

    const orderPreview = await dhan.createOptionOrderPreview({
      symbol,
      signal,
      lots,
      includeMargin: tradingMode === 'LIVE',
      riskSettings: autoTradeConfig.settings
    });
    if (tradingMode !== requestedMode || !dhan.getConnection()) {
      return res.status(409).json({ ok: false, message: 'Connection or trading mode changed while preparing this preview. Try again.' });
    }

    const previewId = randomUUID();
    for (const [id, pending] of orderPreviews) {
      if (pending.expiresAt < Date.now()) orderPreviews.delete(id);
    }
    if (orderPreviews.size >= 20) return res.status(429).json({ ok: false, message: 'Too many pending previews. Confirm or wait for one to expire.' });

    orderPreviews.set(previewId, { ...orderPreview, mode: requestedMode, symbol, signal, lots, expiresAt: Date.now() + 120000 });
    const orderNotional = Number(orderPreview.preview['Order notional']);
    const warning = orderNotional > 50000
      ? `Warning: estimated notional ₹${orderNotional.toLocaleString('en-IN')} exceeds ₹50,000. ${orderPreview.warning}`
      : orderPreview.warning;
    res.json({ ok: true, previewId, mode: requestedMode, preview: orderPreview.preview, warning });
  } catch (error) {
    res.status(error.statusCode || 502).json({ ok: false, message: error.message });
  }
});

app.post('/api/trade/execute', async (req, res) => {
  const { previewId } = req.body || {};
  const preview = orderPreviews.get(previewId);
  if (!preview) return res.status(404).json({ ok: false, message: 'Order preview not found or already used. Create a fresh preview.' });
  orderPreviews.delete(previewId);
  if (preview.expiresAt < Date.now() || preview.mode !== tradingMode) {
    return res.status(409).json({ ok: false, message: 'The preview expired or trading mode changed. Create a fresh preview.' });
  }
  if (!isEntryWindowOpen()) {
    return res.status(409).json({ ok: false, message: 'New entries are allowed only on weekdays from 09:45 to before 14:00 IST.' });
  }

  try {
    await marketSafety.assertCanTrade(preview.symbol);
  } catch (error) {
    return res.status(409).json({ ok: false, message: error.message });
  }

  const liveSymbol = preview.underlying;
  if (tradingMode === 'LIVE') {
    const held = liveSubmissionLocks.get(liveSymbol);
    if (held) {
      try {
        const [superOrders, regularOrders] = await Promise.all([dhan.getSuperOrders(), dhan.getOrders()]);
        for (const [reservedSymbol, reservation] of liveSubmissionLocks) {
          if (isReconciledOrderTerminal(superOrders, regularOrders, reservation)) {
            liveSubmissionLocks.delete(reservedSymbol);
          }
        }
        if (liveSubmissionLocks.has(liveSymbol)) {
          return res.status(409).json({ ok: false, message: `${liveSymbol} already has a live order being reconciled. Check Dhan order status before trying again.` });
        }
      } catch (error) {
        return res.status(error.statusCode || 502).json({ ok: false, message: `Could not reconcile the existing ${liveSymbol} order. Check Dhan before retrying. ${error.message}` });
      }
    }
    liveSubmissionLocks.set(liveSymbol, { correlationId: preview.order.correlationId, state: 'checking' });
  }

  try {
    const latestScan = await dhan.getLiveScan();
    const currentRow = latestScan.results.find((item) => item.symbol === preview.symbol);
    if (tradingMode === 'PAPER') syncPaperTrades(latestScan.optionQuotes);
    if (currentRow?.signal !== preview.signal || currentRow.dataState !== 'READY') {
      if (tradingMode === 'LIVE') liveSubmissionLocks.delete(liveSymbol);
      return res.status(409).json({ ok: false, message: 'The confirmed 15-minute signal changed after preview. Refresh the scanner and create a fresh preview.' });
    }
  } catch (error) {
    if (tradingMode === 'LIVE') liveSubmissionLocks.delete(liveSymbol);
    return res.status(error.statusCode || 502).json({ ok: false, message: error.message });
  }

  if (tradingMode !== preview.mode) {
    if (preview.mode === 'LIVE') liveSubmissionLocks.delete(liveSymbol);
    return res.status(409).json({ ok: false, message: 'Trading mode changed. Create a fresh preview.' });
  }

  if (tradingMode === 'PAPER') {
    if (activeTrades.has(preview.symbol) || activeTrades.size >= autoTradeConfig.settings.maxTrades) {
      return res.status(409).json({ ok: false, message: 'Paper position limit reached. Refresh positions and create a new preview.' });
    }

    const trade = createPaperTrade({ ...preview, lots: preview.lots });
    void notify('info', 'Paper position opened after manual confirmation.', {
      symbol: preview.symbol,
      signal: preview.signal,
      lots: preview.lots
    });
    return res.json({ ok: true, status: 'paper_filled', trade, message: `${preview.symbol} paper option order recorded at ${preview.order.price}.` });
  }

  let orderSubmissionAttempted = false;
  try {
    if (!dhan.getConnection()) {
      liveSubmissionLocks.delete(liveSymbol);
      return res.status(401).json({ ok: false, message: 'Dhan connection was lost. Reconnect before submitting an order.' });
    }
    if (tradingMode !== preview.mode) {
      liveSubmissionLocks.delete(liveSymbol);
      return res.status(409).json({ ok: false, message: 'Trading mode changed. Create a fresh preview.' });
    }
    const [positions, superOrders, regularOrders] = await Promise.all([
      dhan.getPositions(),
      dhan.getSuperOrders(),
      dhan.getOrders()
    ]);
    const openPositions = positions.filter((position) => Number(position.netQty) !== 0);
    const pendingUnderlyingOrder = findActiveSuperOrder(superOrders, preview.underlying)
      || findActiveRegularOrder(regularOrders, preview.underlying);
    if (openPositions.some((position) => positionMatchesUnderlying(position, preview.underlying)) || pendingUnderlyingOrder) {
      liveSubmissionLocks.delete(liveSymbol);
      return res.status(409).json({ ok: false, message: `${preview.underlying} already has an open position or active order at Dhan.` });
    }
    const reservedSymbols = new Set();
    const addReservation = (symbol) => {
      if (symbol && !openPositions.some((position) => positionMatchesUnderlying(position, symbol))) reservedSymbols.add(symbol);
    };
    for (const order of superOrders) {
      if (['TRANSIT', 'PENDING', 'PART_TRADED', 'TRADED'].includes(String(order.orderStatus).toUpperCase())) {
        const name = String(order.tradingSymbol || order.securityName || '').toUpperCase();
        addReservation(Array.from(allowedSymbols).find((symbol) => name === symbol || name.startsWith(`${symbol}-`) || name.startsWith(`${symbol} `)) || `order:${order.orderId || order.correlationId}`);
      }
    }
    for (const order of regularOrders.filter(isActiveRegularOrder)) {
      const name = String(order.tradingSymbol || order.securityName || '').toUpperCase();
      addReservation(Array.from(allowedSymbols).find((symbol) => name === symbol || name.startsWith(`${symbol}-`) || name.startsWith(`${symbol} `)) || `regular-order:${order.orderId || order.correlationId || order.securityId}`);
    }
    for (const symbol of liveSubmissionLocks.keys()) addReservation(symbol);
    if (openPositions.length + reservedSymbols.size > MAX_ACTIVE_TRADES) {
      liveSubmissionLocks.delete(liveSymbol);
      return res.status(409).json({ ok: false, message: `The maximum of ${MAX_ACTIVE_TRADES} live positions has been reached.` });
    }
    const margin = await dhan.checkOrderMargin(preview.order);
    const [finalPositions, finalOrders, finalRegularOrders] = await Promise.all([
      dhan.getPositions(),
      dhan.getSuperOrders(),
      dhan.getOrders()
    ]);
    if (finalPositions.some((position) => positionMatchesUnderlying(position, preview.underlying))
      || findActiveSuperOrder(finalOrders, preview.underlying)
      || findActiveRegularOrder(finalRegularOrders, preview.underlying)) {
      liveSubmissionLocks.delete(liveSymbol);
      return res.status(409).json({ ok: false, message: `${preview.underlying} acquired a live position or active order during final checks.` });
    }
    if (countLiveExposure(finalPositions, finalOrders, finalRegularOrders) > autoTradeConfig.settings.maxTrades) {
      liveSubmissionLocks.delete(liveSymbol);
      return res.status(409).json({ ok: false, message: `The configured maximum of ${autoTradeConfig.settings.maxTrades} live positions has been reached.` });
    }
    await marketSafety.assertCanTrade(preview.symbol);
    if (!dhan.getConnection() || tradingMode !== preview.mode || !isEntryWindowOpen()) {
      liveSubmissionLocks.delete(liveSymbol);
      return res.status(409).json({ ok: false, message: 'Connection, mode, or entry window changed during broker checks. Create a fresh preview.' });
    }
    const liveTrade = {
      symbol: preview.symbol,
      securityId: preview.order.securityId,
      tickSize: preview.tickSize,
      entryPrice: preview.order.price,
      quantity: preview.order.quantity,
      openedAt: new Date().toISOString(),
      status: 'SUBMITTING',
      lastPnlInr: 0,
      correlationId: preview.order.correlationId
    };
    liveTrades.push(liveTrade);
    try {
      saveLocalState();
    } catch (error) {
      liveTrades.pop();
      throw error;
    }
    liveSubmissionLocks.set(liveSymbol, { correlationId: preview.order.correlationId, state: 'submitting' });
    orderSubmissionAttempted = true;
    const result = await dhan.placeSuperOrder(preview.order);
    const orderData = result.data || result;
    liveSubmissionLocks.set(liveSymbol, {
      correlationId: preview.order.correlationId,
      orderId: orderData.orderId || orderData.order_id || null,
      state: 'submitted'
    });
    liveTrade.status = 'SUBMITTED';
    liveTrade.orderId = orderData.orderId || orderData.order_id || null;
    let trackingWarning = '';
    try {
      saveLocalState();
    } catch (error) {
      autoTradeConfig.enabled = false;
      trackingWarning = ` Local trade tracking could not be saved (${error.message}); automatic entries are disabled. Check Dhan's order book.`;
      console.error(`Live order accepted but local tracking could not be saved: ${error.message}`);
    }
    void notify('warning', 'Manually confirmed live order submitted to Dhan.', {
      symbol: preview.symbol,
      orderId: liveTrade.orderId || 'pending',
      estimatedMargin: margin.totalMargin,
      availableFunds: margin.availableFunds
    });
    res.json({
      ok: true,
      status: 'submitted',
      orderId: orderData.orderId || orderData.order_id || null,
      orderStatus: orderData.orderStatus || orderData.order_status || 'PENDING',
      message: `Dhan accepted the live ${preview.preview.Action} order request. Check broker order status before assuming a fill.${trackingWarning}`
    });
  } catch (error) {
    const held = liveSubmissionLocks.get(liveSymbol);
    if (held && orderSubmissionAttempted) held.state = 'uncertain';
    else liveSubmissionLocks.delete(liveSymbol);
    res.status(error.statusCode || 502).json({ ok: false, message: error.message });
  }
});

app.post('/api/trade/close', (req, res) => {
  if (tradingMode !== 'PAPER') {
    return res.status(409).json({ ok: false, message: 'Live positions are managed by Dhan. Close or modify them through the broker order flow.' });
  }
  const { symbol } = req.body || {};

  if (typeof symbol !== 'string' || !allowedSymbols.has(symbol)) {
    return res.status(400).json({ ok: false, message: 'Choose a supported F&O symbol.' });
  }

  const current = activeTrades.get(symbol);
  if (!current) {
    return res.status(404).json({ ok: false, message: `${symbol} has no active position to close.` });
  }

  const previousTrade = { ...current };
  const closeValue = current.currentPrice || current.entryPrice;
  current.status = 'CLOSED';
  current.exitReason = 'MANUAL';
  current.exitPrice = closeValue;
  current.closedAt = new Date().toISOString();
  current.pnlPct = ((current.entryPrice - closeValue) / current.entryPrice) * 100;

  try {
    recordClosedTrade(current);
  } catch (error) {
    Object.assign(current, previousTrade);
    return res.status(500).json({ ok: false, message: `Could not persist the closed paper trade: ${error.message}` });
  }
  activeTrades.delete(symbol);

  res.json({ ok: true, status: 'closed', trade: current, message: `${symbol} closed and counted as a closed position.` });
});

app.post('/api/auto-trade', async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, message: 'Choose Manual or Auto mode.' });
  }
  if (enabled && tradingMode === 'LIVE' && !dhan.getConnection()) {
    return res.status(401).json({ ok: false, message: 'Connect Dhan before enabling Live Auto trade.' });
  }
  if (enabled && tradingMode === 'LIVE') {
    try {
      await dhan.verifyConnection();
    } catch (error) {
      return res.status(401).json({ ok: false, message: `Dhan profile verification failed: ${error.message}` });
    }
  }
  let settings;
  try {
    settings = validateTradeSettings(req.body || {}, autoTradeConfig.settings);
    if (enabled && tradingMode === 'LIVE') {
      const missing = missingRiskSettings(settings);
      if (missing.length) throw new Error(`Configure these trade controls before enabling Auto trade: ${missing.join(', ')}.`);
    }
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message });
  }

  const previous = { settings: autoTradeConfig.settings, enabled: autoTradeConfig.enabled };
  const liveSubmissionInProgress = Array.from(liveSubmissionLocks.values())
    .some((reservation) => reservation.state === 'submitting');
  autoTradeConfig.settings = settings;
  autoTradeConfig.enabled = enabled;
  autoTradeConfig.lastError = null;
  try {
    saveLocalState();
  } catch (error) {
    autoTradeConfig.settings = previous.settings;
    autoTradeConfig.enabled = previous.enabled;
    return res.status(500).json({ ok: false, message: `Could not save local trade settings: ${error.message}` });
  }
  res.json({
    ok: true,
    enabled,
    mode: tradingMode,
    settings,
    riskReady: missingRiskSettings(settings).length === 0,
    missingRiskSettings: missingRiskSettings(settings),
    message: !enabled
      ? `Manual mode enabled. Choose a signal and preview each entry.${liveSubmissionInProgress ? ' A live order was already being submitted; check Dhan for its latest status.' : ''}`
      : tradingMode === 'PAPER'
          ? missingRiskSettings(settings).length
            ? `Paper Auto trade enabled. Simulated entries are blocked until these controls are saved: ${missingRiskSettings(settings).join(', ')}. No broker orders are placed.`
            : dhan.getConnection()
              ? 'Paper Auto trade enabled. Confirmed signals open simulated positions; no broker orders are placed.'
              : 'Paper Auto trade enabled. Connect Dhan for market data before simulated entries can open; no broker orders are placed.'
          : 'Live auto mode enabled. The server checks positions and active orders before each automatic stock-option entry.'
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.statusCode) || 500;
  const message = status === 400 ? 'Invalid JSON request body.'
    : status === 413 ? 'Request body is too large.'
      : 'The local server could not complete this request.';
  res.status(status).json({ ok: false, message });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Dhan Intraday Desk running at http://localhost:${PORT}`);
  const clientId = process.env.DHAN_CLIENT_ID?.trim();
  const accessToken = process.env.DHAN_ACCESS_TOKEN?.trim();

  if (!clientId && !accessToken) return;
  if (!clientId || !accessToken) {
    console.error('Dhan startup connection skipped: set both DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN in .env.');
    return;
  }

  dhan.connect(clientId, accessToken)
    .then((profile) => {
      console.log(`Connected to Dhan as ${profile.name} using .env credentials.`);
      tokenRenewalStatus = { enabled: true, message: 'Dhan token connected. Automatic renewal is starting.' };
      renewConfiguredToken();
    })
    .catch((error) => console.error(`Dhan startup connection failed: ${error.message}`));
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Could not start: port ${PORT} is already in use. Stop the other server or set a different PORT in .env.`);
  } else {
    console.error(`Could not start the local server: ${error.message}`);
  }
  process.exitCode = 1;
});

const serverAutoScanTimer = setInterval(() => {
  const hasManagedPositions = activeTrades.size > 0 || liveTrades.some((trade) => trade.status !== 'CLOSED');
  if ((!autoTradeConfig.enabled && !hasManagedPositions) || !dhan.getConnection()) return;
  updateMarketSnapshot().catch((error) => { autoTradeConfig.lastError = error.message; });
}, 1000);
serverAutoScanTimer.unref();
