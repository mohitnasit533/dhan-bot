'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  lotSize: 1,
  maxTrades: 5,
  dailyLossScope: 'bot',
  maxDailyLossInr: null,
  stopLossInr: null,
  targetInr: null,
  minOpenInterest: 1000,
  maxSpreadPct: 2
});

const RISK_FIELDS = [
  ['maxDailyLossInr', 'Daily max loss (INR)'],
  ['stopLossInr', 'Stop loss (INR per position)'],
  ['targetInr', 'Profit target (INR per position)'],
  ['minOpenInterest', 'Minimum option open interest'],
  ['maxSpreadPct', 'Maximum option bid/ask spread (%)']
];

function parseOptionalPositiveNumber(value, label, maximum = Infinity) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${label} must be greater than 0${Number.isFinite(maximum) ? ` and no more than ${maximum}` : ''}.`);
  }
  return parsed;
}

function validateTradeSettings(input, current = DEFAULT_SETTINGS) {
  const value = (key) => Object.hasOwn(input, key) ? input[key] : current[key];
  const settings = {
    lotSize: Number(value('lotSize')),
    maxTrades: Number(value('maxTrades')),
    dailyLossScope: value('dailyLossScope'),
    maxDailyLossInr: parseOptionalPositiveNumber(value('maxDailyLossInr'), 'Daily max loss'),
    stopLossInr: parseOptionalPositiveNumber(value('stopLossInr'), 'Stop loss'),
    targetInr: parseOptionalPositiveNumber(value('targetInr'), 'Profit target'),
    minOpenInterest: parseOptionalPositiveNumber(value('minOpenInterest'), 'Minimum open interest'),
    maxSpreadPct: parseOptionalPositiveNumber(value('maxSpreadPct'), 'Maximum spread', 100)
  };

  if (!Number.isInteger(settings.lotSize) || settings.lotSize < 1 || settings.lotSize > 1000) {
    throw new Error('Lot size must be an integer from 1 to 1000.');
  }
  if (!Number.isInteger(settings.maxTrades) || settings.maxTrades < 1 || settings.maxTrades > 5) {
    throw new Error('Maximum positions must be an integer from 1 to 5.');
  }
  if (settings.dailyLossScope !== 'bot') {
    throw new Error('Daily loss scope must be this bot only.');
  }
  return settings;
}

function missingRiskSettings(settings) {
  return RISK_FIELDS
    .filter(([key]) => !Number.isFinite(Number(settings[key])) || Number(settings[key]) <= 0)
    .map(([, label]) => label);
}

function indiaDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function calculatePaperDailyPnl(activeTrades, closedTrades, date = new Date()) {
  const today = indiaDate(date);
  const realized = closedTrades.reduce((total, trade) => {
    const closedDate = trade.closedAt ? indiaDate(new Date(trade.closedAt)) : null;
    return closedDate === today ? total + Number(trade.pnlInr || 0) : total;
  }, 0);
  const unrealized = activeTrades.reduce((total, trade) => {
    const currentDate = trade.openedAt ? indiaDate(new Date(trade.openedAt)) : null;
    if (currentDate !== today) return total;
    const entry = Number(trade.entryPrice);
    const current = Number(trade.currentPrice ?? entry);
    const quantity = Number(trade.quantity);
    return Number.isFinite(entry) && Number.isFinite(current) && Number.isFinite(quantity)
      ? total + ((entry - current) * quantity)
      : total;
  }, 0);
  return realized + unrealized;
}

function calculateBotLiveDailyPnl(liveTrades, brokerPositions, date = new Date()) {
  const today = indiaDate(date);
  const todaysTrades = liveTrades.filter((trade) => trade.openedAt && indiaDate(new Date(trade.openedAt)) === today);
  const positionsBySecurityId = new Map(brokerPositions.map((position) => [String(position.securityId || ''), position]));
  const seen = new Set();
  return todaysTrades.reduce((total, trade) => {
    const securityId = String(trade.securityId || '');
    if (!securityId || seen.has(securityId)) return total;
    seen.add(securityId);
    const position = positionsBySecurityId.get(securityId);
    if (!position) return total + Number(trade.lastPnlInr || 0);
    const realized = Number(position.realizedProfit ?? position.realisedProfit ?? 0);
    const unrealized = Number(position.unrealizedProfit ?? position.unrealisedProfit ?? 0);
    return Number.isFinite(realized) && Number.isFinite(unrealized)
      ? total + realized + unrealized
      : total + Number(trade.lastPnlInr || 0);
  }, 0);
}

function dailyLossReached(dailyPnlInr, maxDailyLossInr) {
  return Number.isFinite(Number(maxDailyLossInr))
    && Number(maxDailyLossInr) > 0
    && Number(dailyPnlInr) <= -Number(maxDailyLossInr);
}

module.exports = {
  DEFAULT_SETTINGS,
  RISK_FIELDS,
  validateTradeSettings,
  missingRiskSettings,
  indiaDate,
  calculatePaperDailyPnl,
  calculateBotLiveDailyPnl,
  dailyLossReached
};
