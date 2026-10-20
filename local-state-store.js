'use strict';

const fs = require('node:fs');

const STATE_VERSION = 2;
const MAX_CLOSED_TRADES = 1000;

function defaultState(settings) {
  return {
    version: STATE_VERSION,
    settings: { ...settings },
    activeTrades: [],
    closedTrades: [],
    liveTrades: []
  };
}

function validateState(value, defaults, validateSettings) {
  if (!value || value.version !== STATE_VERSION
    || !Array.isArray(value.activeTrades) || !Array.isArray(value.closedTrades) || !Array.isArray(value.liveTrades)
    || typeof value.settings !== 'object' || value.settings === null) {
    throw new Error('Saved local trading state has an invalid format. Back up and inspect .dhan-local-state.json before continuing.');
  }
  const trades = [...value.activeTrades, ...value.closedTrades, ...value.liveTrades];
  const validTrade = (trade) => trade
    && typeof trade.symbol === 'string' && trade.symbol.trim() !== ''
    && Number.isFinite(Number(trade.entryPrice)) && Number(trade.entryPrice) > 0
    && Number.isSafeInteger(Number(trade.quantity)) && Number(trade.quantity) > 0
    && typeof trade.openedAt === 'string' && Number.isFinite(Date.parse(trade.openedAt));
  if (trades.length > 10000
    || trades.some((trade) => !validTrade(trade))
    || value.activeTrades.some((trade) => trade.status !== 'OPEN')
    || value.closedTrades.some((trade) => trade.status !== 'CLOSED' || !Number.isFinite(Date.parse(trade.closedAt)))
    || value.liveTrades.some((trade) => !['SUBMITTING', 'SUBMITTED', 'CLOSED'].includes(trade.status))) {
    throw new Error('Saved local trading state contains invalid trades. Back up and inspect .dhan-local-state.json before continuing.');
  }
  return {
    version: STATE_VERSION,
    settings: validateSettings(value.settings, defaults),
    activeTrades: value.activeTrades,
    closedTrades: value.closedTrades.slice(-MAX_CLOSED_TRADES),
    liveTrades: value.liveTrades.slice(-MAX_CLOSED_TRADES)
  };
}

function createLocalStateStore(statePath, defaults, validateSettings) {
  let state = defaultState(defaults);
  let savedData;
  try {
    savedData = fs.readFileSync(statePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return createStore(statePath, state, defaults, validateSettings);
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(savedData);
  } catch {
    throw new Error('Saved local trading state is corrupt. Back up and inspect .dhan-local-state.json before continuing.');
  }
  state = validateState(parsed, defaults, validateSettings);
  return createStore(statePath, state, defaults, validateSettings);
}

function createStore(statePath, initialState, defaults, validateSettings) {
  let state = initialState;
  function save(nextState) {
    const validState = validateState({
      version: STATE_VERSION,
      settings: nextState.settings,
      activeTrades: nextState.activeTrades,
      closedTrades: nextState.closedTrades,
      liveTrades: nextState.liveTrades
    }, defaults, validateSettings);
    const temporaryPath = `${statePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(validState), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, statePath);
    state = validState;
    return state;
  }

  return { getState: () => state, save };
}

module.exports = { createLocalStateStore };
