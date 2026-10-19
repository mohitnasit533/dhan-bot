'use strict';

const express = require('express');
const path = require('path');
const { randomUUID } = require('node:crypto');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const dhan = require('./dhan');
const { isEntryWindowOpen } = dhan;
const { isAllowedLocalHost, isSameOriginRequest } = require('./local-security');
const { findActiveSuperOrder, isTerminalSuperOrder, findReconciledOrder } = require('./live-order-guard');
const { createAutoSignalStore } = require('./auto-signal-store');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';
const AUTO_SIGNAL_STATE_PATH = path.join(__dirname, '.dhan-auto-state.json');
const MAX_ACTIVE_TRADES = 5;
const MAX_CLOSED_TRADES = 1000;
let tradingMode = 'PAPER';

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
const activeTrades = new Map();
const closedTrades = [];
const orderPreviews = new Map();
const autoSignalStore = createAutoSignalStore(AUTO_SIGNAL_STATE_PATH);
const lastAutoSignals = autoSignalStore.signals;
const liveSubmissionLocks = new Map();
const autoTradeConfig = {
  enabled: false,
  settings: { lotSize: 1, maxTrades: 5, stopLossPct: 20, targetPct: 50 }
};

const rememberAutoSignal = autoSignalStore.remember;

function recordClosedTrade(trade) {
  closedTrades.push({ ...trade });
  if (closedTrades.length > MAX_CLOSED_TRADES) closedTrades.shift();
}

function getActiveTradesList() {
  return Array.from(activeTrades.values());
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
    strike: preview.preview.Strike,
    expiry: preview.preview.Expiry,
    lotSize: preview.lots,
    quantity: preview.order.quantity,
    entryPrice: preview.order.price,
    currentPrice: preview.order.price,
    stopPrice: preview.order.stopLossPrice,
    targetPrice: preview.order.targetPrice,
    stopLossPct: preview.risk.stopLossPct,
    targetPct: preview.risk.targetPct,
    status: 'OPEN',
    openedAt: new Date().toISOString(),
    pnlPct: 0,
    entryType: preview.entryType || 'MANUAL'
  };
  activeTrades.set(preview.symbol, trade);
  return trade;
}

function positionMatchesUnderlying(position, symbol) {
  const instrumentName = String(position.tradingSymbol || position.securityName || '').toUpperCase();
  return instrumentName === symbol || instrumentName.startsWith(`${symbol}-`) || instrumentName.startsWith(`${symbol} `);
}

function syncPaperTrades(optionQuotes) {
  for (const trade of getActiveTradesList()) {
    const currentPrice = Number(optionQuotes[trade.securityId]?.last_price);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;

    trade.currentPrice = currentPrice;

    const pnlPct = ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100;

    trade.pnlPct = pnlPct;

    const shouldClose = currentPrice >= trade.stopPrice || currentPrice <= trade.targetPrice;
    if (shouldClose) {
      trade.status = 'CLOSED';
      trade.exitReason = currentPrice >= trade.stopPrice ? 'STOP_LOSS' : 'TARGET';
      trade.exitPrice = currentPrice;
      trade.closedAt = new Date().toISOString();
      recordClosedTrade(trade);
      activeTrades.delete(trade.symbol);
    }
  }
}

async function runPaperAutoTrades(results) {
  if (!isEntryWindowOpen()) return;

  for (const result of results) {
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
      const orderPreview = await dhan.createOptionOrderPreview({
        symbol: result.symbol,
        signal: result.signal,
        lots: autoTradeConfig.settings.lotSize,
        includeMargin: false
      });
      if (!rememberAutoSignal(result.symbol, signalKey)) continue;
      createPaperTrade({ ...orderPreview, symbol: result.symbol, lots: autoTradeConfig.settings.lotSize, entryType: 'AUTO' });
      autoTradeConfig.lastError = null;
    } catch (error) {
      autoTradeConfig.lastError = `${result.symbol}: ${error.message}`;
    }
  }
}

function countLiveExposure(positions, superOrders) {
  const openPositions = positions.filter((position) => Number(position.netQty) !== 0);
  const reservations = new Set();
  for (const order of superOrders) {
    if (!['TRANSIT', 'PENDING', 'PART_TRADED', 'TRADED'].includes(String(order.orderStatus).toUpperCase())) continue;
    const name = String(order.tradingSymbol || order.securityName || '').toUpperCase();
    const symbol = Array.from(allowedSymbols).find((candidate) => name === candidate || name.startsWith(`${candidate}-`) || name.startsWith(`${candidate} `));
    const reservation = symbol || `order:${order.orderId || order.correlationId}`;
    if (!openPositions.some((position) => symbol && positionMatchesUnderlying(position, symbol))) reservations.add(reservation);
  }
  for (const symbol of liveSubmissionLocks.keys()) {
    if (!openPositions.some((position) => positionMatchesUnderlying(position, symbol))) reservations.add(symbol);
  }
  return openPositions.length + reservations.size;
}

async function runLiveAutoTrades(results, positions, superOrders) {
  if (!autoTradeConfig.enabled || tradingMode !== 'LIVE' || !dhan.getConnection() || !isEntryWindowOpen()) return;

  for (const result of results) {
    if (result.dataState !== 'READY' || !['BUY', 'SELL'].includes(result.signal)) continue;
    const signalKey = `${result.lastCandleAt || 'unknown'}:${result.signal}`;
    if (lastAutoSignals.get(result.symbol) === signalKey) continue;
    if (positions.some((position) => positionMatchesUnderlying(position, result.symbol))
      || findActiveSuperOrder(superOrders, result.symbol)
      || liveSubmissionLocks.has(result.symbol)) {
      try { rememberAutoSignal(result.symbol, signalKey); } catch (error) {
        autoTradeConfig.lastError = `Could not save auto-trade duplicate protection: ${error.message}`;
      }
      continue;
    }
    if (countLiveExposure(positions, superOrders) >= autoTradeConfig.settings.maxTrades) continue;
    const reservation = { correlationId: null, state: 'preparing' };
    liveSubmissionLocks.set(result.symbol, reservation);
    let orderSubmissionAttempted = false;
    try {
      const preview = await dhan.createOptionOrderPreview({
        symbol: result.symbol,
        signal: result.signal,
        lots: autoTradeConfig.settings.lotSize
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

      const [currentPositions, currentOrders] = await Promise.all([dhan.getPositions(), dhan.getSuperOrders()]);
      const currentOpenPositions = currentPositions.filter((position) => Number(position.netQty) !== 0);
      if (currentOpenPositions.some((position) => positionMatchesUnderlying(position, result.symbol))
        || findActiveSuperOrder(currentOrders, result.symbol)) {
        liveSubmissionLocks.delete(result.symbol);
        continue;
      }
      if (countLiveExposure(currentPositions, currentOrders) > autoTradeConfig.settings.maxTrades) {
        liveSubmissionLocks.delete(result.symbol);
        continue;
      }
      if (!autoTradeConfig.enabled || tradingMode !== 'LIVE' || !dhan.getConnection() || !isEntryWindowOpen()) {
        liveSubmissionLocks.delete(result.symbol);
        continue;
      }

      if (!rememberAutoSignal(result.symbol, signalKey)) {
        liveSubmissionLocks.delete(result.symbol);
        continue;
      }
      reservation.correlationId = preview.order.correlationId;
      reservation.state = 'submitting';
      orderSubmissionAttempted = true;
      const response = await dhan.placeSuperOrder(preview.order);
      const orderData = response.data || response;
      reservation.orderId = orderData.orderId || orderData.order_id || null;
      reservation.state = 'submitted';
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
function scheduleLiveAutoTrades(results, positions, superOrders) {
  latestLiveAutoSnapshot = { results, positions, superOrders };
  if (liveAutoQueueRunning) return;
  liveAutoQueueRunning = true;
  setImmediate(async () => {
    try {
      while (latestLiveAutoSnapshot) {
        const snapshot = latestLiveAutoSnapshot;
        latestLiveAutoSnapshot = null;
        await runLiveAutoTrades(snapshot.results, snapshot.positions, snapshot.superOrders);
      }
    } catch (error) {
      autoTradeConfig.lastError = error.message;
    } finally {
      liveAutoQueueRunning = false;
      if (latestLiveAutoSnapshot) scheduleLiveAutoTrades(
        latestLiveAutoSnapshot.results,
        latestLiveAutoSnapshot.positions,
        latestLiveAutoSnapshot.superOrders
      );
    }
  });
}

let marketCyclePromise = null;
let marketSnapshot = null;
async function updateMarketSnapshot() {
  if (marketCyclePromise) return marketCyclePromise;
  const cycle = (async () => {
    const optionIds = tradingMode === 'PAPER' ? getActiveTradesList().map((trade) => trade.securityId) : [];
    const scan = await dhan.getLiveScan(optionIds);
    allowedSymbols = new Set(scan.results.map((row) => row.symbol));
    if (tradingMode === 'PAPER') {
      syncPaperTrades(scan.optionQuotes);
      if (autoTradeConfig.enabled) await runPaperAutoTrades(scan.results);
      marketSnapshot = { scan, brokerPositions: [], activePositions: getActiveTradesList() };
    } else {
      const [positions, superOrders] = await Promise.all([dhan.getPositions(), dhan.getSuperOrders()]);
      const brokerPositions = positions.filter((position) => Number(position.netQty) !== 0);
      for (const [symbol, reservation] of liveSubmissionLocks) {
        const order = findReconciledOrder(superOrders, reservation);
        if (order && isTerminalSuperOrder(order)) liveSubmissionLocks.delete(symbol);
      }
      if (autoTradeConfig.enabled) scheduleLiveAutoTrades(scan.results, brokerPositions, superOrders);
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

app.get('/api/connection', (req, res) => {
  res.json({
    ok: true,
    connected: Boolean(dhan.getConnection()),
    profile: dhan.getConnection(),
    mode: tradingMode,
    autoTrade: autoTradeConfig.enabled,
    settings: autoTradeConfig.settings
  });
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
    res.json({
      ok: true,
      connected: true,
      profile,
      mode: tradingMode,
      autoTrade: autoTradeConfig.enabled,
      settings: autoTradeConfig.settings,
      message: `Connected to Dhan as ${profile.name}. Credentials are held in server memory only.`
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, connected: false, message: error.message });
  }
});

app.post('/api/disconnect', (req, res) => {
  dhan.disconnect();
  tradingMode = 'PAPER';
  autoTradeConfig.enabled = false;
  latestLiveAutoSnapshot = null;
  liveSubmissionLocks.clear();
  marketSnapshot = null;
  orderPreviews.clear();
  res.json({ ok: true, connected: false, mode: tradingMode, message: 'Dhan disconnected. Trading mode returned to Paper.' });
});

app.post('/api/mode', (req, res) => {
  const mode = req.body?.mode;
  if (mode !== 'PAPER' && mode !== 'LIVE') {
    return res.status(400).json({ ok: false, message: 'Mode must be PAPER or LIVE.' });
  }
  if (mode === 'LIVE' && !dhan.getConnection()) {
    return res.status(409).json({ ok: false, message: 'Connect and verify your Dhan account before enabling Live mode.' });
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
    return res.json({ ok: true, connected: false, mode: tradingMode, liveData: false, results: [], activePositions: [], brokerPositions: [], message: 'Connect Dhan to load live market data.' });
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
      autoTrade: {
        enabled: autoTradeConfig.enabled,
        mode: tradingMode,
        status: autoTradeConfig.enabled && tradingMode === 'LIVE' ? 'live_auto_enabled' : 'ready',
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
    const scan = await dhan.getLiveScan(getActiveTradesList().map((trade) => trade.securityId));
    const signalRow = scan.results.find((item) => item.symbol === symbol);
    if (!signalRow || signalRow.signal !== signal) {
      return res.status(409).json({ ok: false, message: 'The confirmed 15-minute signal has changed. Refresh the scanner before previewing.' });
    }

    if (tradingMode === 'LIVE') {
      const positions = await dhan.getPositions();
      const openPositions = positions.filter((position) => Number(position.netQty) !== 0);
      if (openPositions.some((position) => positionMatchesUnderlying(position, symbol))) {
        return res.status(409).json({ ok: false, message: `${symbol} already has an open Dhan position.` });
      }
      if (openPositions.length >= MAX_ACTIVE_TRADES) {
        return res.status(409).json({ ok: false, message: `The maximum of ${MAX_ACTIVE_TRADES} live positions has been reached.` });
      }
    }

    const orderPreview = await dhan.createOptionOrderPreview({
      symbol,
      signal,
      lots
    });

    const previewId = randomUUID();
    for (const [id, pending] of orderPreviews) {
      if (pending.expiresAt < Date.now()) orderPreviews.delete(id);
    }
    if (orderPreviews.size >= 20) return res.status(429).json({ ok: false, message: 'Too many pending previews. Confirm or wait for one to expire.' });

    orderPreviews.set(previewId, { ...orderPreview, mode: tradingMode, symbol, signal, lots, expiresAt: Date.now() + 120000 });
    const orderNotional = Number(orderPreview.preview['Order notional']);
    const warning = orderNotional > 50000
      ? `Warning: estimated notional ₹${orderNotional.toLocaleString('en-IN')} exceeds ₹50,000. ${orderPreview.warning}`
      : orderPreview.warning;
    res.json({ ok: true, previewId, mode: tradingMode, preview: orderPreview.preview, warning });
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

  const liveSymbol = preview.underlying;
  if (tradingMode === 'LIVE') {
    const held = liveSubmissionLocks.get(liveSymbol);
    if (held) {
      try {
        const orders = await dhan.getSuperOrders();
        for (const [reservedSymbol, reservation] of liveSubmissionLocks) {
          const matched = findReconciledOrder(orders, reservation);
          if (matched && isTerminalSuperOrder(matched)) liveSubmissionLocks.delete(reservedSymbol);
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
    const currentSignal = latestScan.results.find((item) => item.symbol === preview.symbol)?.signal;
    if (currentSignal !== preview.signal) {
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
    const [positions, superOrders] = await Promise.all([dhan.getPositions(), dhan.getSuperOrders()]);
    const openPositions = positions.filter((position) => Number(position.netQty) !== 0);
    const pendingUnderlyingOrder = findActiveSuperOrder(superOrders, preview.underlying);
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
    for (const symbol of liveSubmissionLocks.keys()) addReservation(symbol);
    if (openPositions.length + reservedSymbols.size > MAX_ACTIVE_TRADES) {
      liveSubmissionLocks.delete(liveSymbol);
      return res.status(409).json({ ok: false, message: `The maximum of ${MAX_ACTIVE_TRADES} live positions has been reached.` });
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
    res.json({
      ok: true,
      status: 'submitted',
      orderId: orderData.orderId || orderData.order_id || null,
      orderStatus: orderData.orderStatus || orderData.order_status || 'PENDING',
      message: `Dhan accepted the live ${preview.preview.Action} order request. Check broker order status before assuming a fill.`
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

  const closeValue = current.currentPrice || current.entryPrice;
  current.status = 'CLOSED';
  current.exitReason = 'MANUAL';
  current.exitPrice = closeValue;
  current.closedAt = new Date().toISOString();
  current.pnlPct = ((current.entryPrice - closeValue) / current.entryPrice) * 100;

  recordClosedTrade(current);
  activeTrades.delete(symbol);

  res.json({ ok: true, status: 'closed', trade: current, message: `${symbol} closed and counted as a closed position.` });
});

app.post('/api/auto-trade', (req, res) => {
  const { enabled } = req.body || {};
  const settings = {
    lotSize: Number(req.body?.lotSize ?? autoTradeConfig.settings.lotSize),
    maxTrades: Number(req.body?.maxTrades ?? autoTradeConfig.settings.maxTrades),
    stopLossPct: 20,
    targetPct: 50
  };

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, message: 'Choose Manual or Auto mode.' });
  }
  if (settings.lotSize < 1 || settings.lotSize > 1000 || !Number.isInteger(settings.lotSize)
    || settings.maxTrades < 1 || settings.maxTrades > MAX_ACTIVE_TRADES || !Number.isInteger(settings.maxTrades)) {
    return res.status(400).json({ ok: false, message: 'Lot size must be 1-1000 and maximum positions must be 1-5.' });
  }
  if (enabled && !dhan.getConnection()) {
    return res.status(401).json({ ok: false, message: 'Connect Dhan before enabling automatic signal handling.' });
  }

  autoTradeConfig.settings = settings;
  autoTradeConfig.enabled = enabled;
  autoTradeConfig.lastError = null;
  res.json({
    ok: true,
    enabled,
    mode: tradingMode,
    settings,
    message: !enabled
      ? 'Manual mode enabled. Choose a signal and preview each entry.'
      : tradingMode === 'PAPER'
        ? 'Auto mode enabled. Confirmed signals open simulated Paper positions automatically.'
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

app.listen(PORT, HOST, () => {
  console.log(`Dhan Intraday Desk running at http://localhost:${PORT}`);
});

const serverAutoScanTimer = setInterval(() => {
  if (!autoTradeConfig.enabled || !dhan.getConnection()) return;
  updateMarketSnapshot().catch((error) => { autoTradeConfig.lastError = error.message; });
}, 1000);
serverAutoScanTimer.unref();
