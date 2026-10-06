'use strict';

const express = require('express');
const path = require('path');
const { randomUUID } = require('node:crypto');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const dhan = require('./dhan');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';
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
app.use(express.static(path.join(__dirname, 'public')));

const tradeMutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});
app.use('/api/trade', tradeMutationLimiter);

const FNO_SYMBOLS = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'SBIN', 'ICICIBANK', 'LTIM', 'TECHM', 'BAJFINANCE', 'AXISBANK'];
const allowedSymbols = new Set(FNO_SYMBOLS);
const activeTrades = new Map();
const closedTrades = [];
const orderPreviews = new Map();
const lastAutoSignals = new Map();
const autoTradeConfig = {
  enabled: false,
  settings: { lotSize: 1, maxTrades: 5, stopLossPct: 20, targetPct: 50 }
};

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

function isEntryWindowOpen() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).reduce((values, part) => ({ ...values, [part.type]: part.value }), {});
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return !['Sat', 'Sun'].includes(parts.weekday) && minutes >= 585 && minutes < 840;
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
      lastAutoSignals.delete(result.symbol);
      continue;
    }

    const signalKey = `${result.lastCandleAt || 'unknown'}:${result.signal}`;
    if (lastAutoSignals.get(result.symbol) === signalKey) continue;
    lastAutoSignals.set(result.symbol, signalKey);

    if (activeTrades.has(result.symbol) || activeTrades.size >= autoTradeConfig.settings.maxTrades) continue;

    try {
      const orderPreview = await dhan.createOptionOrderPreview({
        symbol: result.symbol,
        signal: result.signal,
        lots: autoTradeConfig.settings.lotSize,
        includeMargin: false
      });
      createPaperTrade({ ...orderPreview, symbol: result.symbol, lots: autoTradeConfig.settings.lotSize, entryType: 'AUTO' });
      autoTradeConfig.lastError = null;
    } catch (error) {
      autoTradeConfig.lastError = `${result.symbol}: ${error.message}`;
    }
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
    ? 'Live mode enabled. Every order still requires a preview and separate confirmation.'
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
    const optionIds = tradingMode === 'PAPER' ? getActiveTradesList().map((trade) => trade.securityId) : [];
    const scan = await dhan.getLiveScan(optionIds);
    if (tradingMode === 'PAPER') {
      syncPaperTrades(scan.optionQuotes);
      if (autoTradeConfig.enabled) await runPaperAutoTrades(scan.results);
    }
    const brokerPositions = tradingMode === 'LIVE' ? await dhan.getPositions() : [];
    res.json({
      ok: true,
      connected: true,
      mode: tradingMode,
      liveData: true,
      results: scan.results,
      maxTrades: MAX_ACTIVE_TRADES,
      strategy: '15m EMA 21/34 crossover + Supertrend + VWAP + narrow CPR breakout; stock options only',
      activePositions: tradingMode === 'PAPER' ? getActiveTradesList() : [],
      brokerPositions,
      closedPositions: closedTrades,
      autoTrade: {
        enabled: autoTradeConfig.enabled,
        mode: tradingMode,
        status: autoTradeConfig.enabled && tradingMode === 'LIVE' ? 'signals_require_confirmation' : 'ready',
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

  try {
    const latestScan = await dhan.getLiveScan();
    const currentSignal = latestScan.results.find((item) => item.symbol === preview.symbol)?.signal;
    if (currentSignal !== preview.signal) {
      return res.status(409).json({ ok: false, message: 'The confirmed 15-minute signal changed after preview. Refresh the scanner and create a fresh preview.' });
    }
  } catch (error) {
    return res.status(error.statusCode || 502).json({ ok: false, message: error.message });
  }

  if (tradingMode === 'PAPER') {
    if (activeTrades.has(preview.symbol) || activeTrades.size >= autoTradeConfig.settings.maxTrades) {
      return res.status(409).json({ ok: false, message: 'Paper position limit reached. Refresh positions and create a new preview.' });
    }

    const trade = createPaperTrade({ ...preview, lots: preview.lots });
    return res.json({ ok: true, status: 'paper_filled', trade, message: `${preview.symbol} paper option order recorded at ${preview.order.price}.` });
  }

  try {
    if (!dhan.getConnection()) return res.status(401).json({ ok: false, message: 'Dhan connection was lost. Reconnect before submitting an order.' });
    const positions = await dhan.getPositions();
    const openPositions = positions.filter((position) => Number(position.netQty) !== 0);
    if (openPositions.some((position) => positionMatchesUnderlying(position, preview.underlying))) {
      return res.status(409).json({ ok: false, message: `${preview.underlying} already has an open Dhan position.` });
    }
    if (openPositions.length >= MAX_ACTIVE_TRADES) {
      return res.status(409).json({ ok: false, message: `The maximum of ${MAX_ACTIVE_TRADES} live positions has been reached.` });
    }
    const result = await dhan.placeSuperOrder(preview.order);
    const orderData = result.data || result;
    res.json({
      ok: true,
      status: 'submitted',
      orderId: orderData.orderId || orderData.order_id || null,
      orderStatus: orderData.orderStatus || orderData.order_status || 'PENDING',
      message: `Dhan accepted the live ${preview.preview.Action} order request. Check broker order status before assuming a fill.`
    });
  } catch (error) {
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
        : 'Auto mode enabled for signal detection. Live orders still wait for your explicit confirmation.'
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Dhan Intraday Desk running at http://localhost:${PORT}`);
});
