'use strict';

const fs = require('node:fs');

function createAutoSignalStore(statePath) {
  const signals = new Map();
  try {
    const savedSignals = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!savedSignals || typeof savedSignals !== 'object' || Array.isArray(savedSignals)) {
      throw new Error('Saved auto-trade signal state has an invalid format.');
    }
    for (const [symbol, signalKey] of Object.entries(savedSignals)) {
      if (!/^[A-Z0-9&._-]{1,30}$/.test(symbol) || typeof signalKey !== 'string' || signalKey.length > 100) {
        throw new Error('Saved auto-trade signal state contains invalid data.');
      }
      signals.set(symbol, signalKey);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Could not safely restore auto-trade duplicate protection: ${error.message}`);
    }
  }

  function remember(symbol, signalKey) {
    if (signals.get(symbol) === signalKey) return false;
    const nextSignals = new Map(signals);
    nextSignals.set(symbol, signalKey);
    const temporaryPath = `${statePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(Object.fromEntries(nextSignals)), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, statePath);
    signals.set(symbol, signalKey);
    return true;
  }

  return { signals, remember };
}

module.exports = { createAutoSignalStore };
