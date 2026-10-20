'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  lotSize: 1,
  maxTrades: 5,
  riskUnit: 'PERCENT',
  stopLossValue: 0,
  targetValue: 0,
  minOpenInterest: 1000,
  maxSpreadPct: 2
});

const RISK_FIELDS = [
  ['minOpenInterest', 'Minimum option open interest'],
  ['maxSpreadPct', 'Maximum option bid/ask spread (%)']
];

function parseNonNegativeNumber(value, label, maximum = Infinity) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${label} must be 0 or greater${Number.isFinite(maximum) ? ` and no more than ${maximum}` : ''}.`);
  }
  return parsed;
}

function validateTradeSettings(input, current = DEFAULT_SETTINGS) {
  const has = (key) => Object.hasOwn(input, key);
  const legacyRiskSettings = !has('stopLossValue') && !has('targetValue')
    && (has('stopLossInr') || has('targetInr'));
  const riskUnit = legacyRiskSettings
    ? 'INR'
    : has('riskUnit') ? input.riskUnit : current.riskUnit || DEFAULT_SETTINGS.riskUnit;
  const stopLossValue = has('stopLossValue')
    ? input.stopLossValue
    : has('stopLossInr') ? input.stopLossInr : current.stopLossValue;
  const targetValue = has('targetValue')
    ? input.targetValue
    : has('targetInr') ? input.targetInr : current.targetValue;
  const value = (key) => has(key) ? input[key] : current[key];
  const settings = {
    lotSize: Number(value('lotSize')),
    maxTrades: Number(value('maxTrades')),
    riskUnit,
    stopLossValue: parseNonNegativeNumber(stopLossValue, 'Stop loss'),
    targetValue: parseNonNegativeNumber(targetValue, 'Profit target'),
    minOpenInterest: Number(value('minOpenInterest')),
    maxSpreadPct: Number(value('maxSpreadPct'))
  };

  if (!Number.isInteger(settings.lotSize) || settings.lotSize < 1 || settings.lotSize > 1000) {
    throw new Error('Lot size must be an integer from 1 to 1000.');
  }
  if (!Number.isInteger(settings.maxTrades) || settings.maxTrades < 1 || settings.maxTrades > 5) {
    throw new Error('Maximum positions must be an integer from 1 to 5.');
  }
  if (!['INR', 'PERCENT'].includes(settings.riskUnit)) {
    throw new Error('Risk unit must be INR or PERCENT.');
  }
  if (settings.riskUnit === 'PERCENT' && settings.targetValue >= 100) {
    throw new Error('Percentage target must be less than 100% of the option premium received.');
  }
  if (!Number.isFinite(settings.minOpenInterest) || settings.minOpenInterest <= 0) {
    throw new Error('Minimum open interest must be greater than 0.');
  }
  if (!Number.isFinite(settings.maxSpreadPct) || settings.maxSpreadPct <= 0 || settings.maxSpreadPct > 100) {
    throw new Error('Maximum spread must be greater than 0 and no more than 100.');
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

function isSquareOffTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).reduce((values, part) => ({ ...values, [part.type]: part.value }), {});
  return !['Sat', 'Sun'].includes(parts.weekday)
    && Number(parts.hour) * 60 + Number(parts.minute) >= 14 * 60 + 58;
}

function indiaMinuteOfDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).reduce((values, part) => ({ ...values, [part.type]: part.value }), {});
  return Number(parts.hour) * 60 + Number(parts.minute);
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

module.exports = {
  DEFAULT_SETTINGS,
  RISK_FIELDS,
  validateTradeSettings,
  missingRiskSettings,
  indiaDate,
  indiaMinuteOfDay,
  isSquareOffTime,
  calculatePaperDailyPnl,
  calculateBotLiveDailyPnl
};
