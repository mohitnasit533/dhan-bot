'use strict';

const fs = require('node:fs');

function createAutoSignalStore(statePath) {
  const signals = new Map();
  try {
    const savedSignals = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (const [symbol, signalKey] of Object.entries(savedSignals)) {
      if (typeof signalKey === 'string') signals.set(symbol, signalKey);
    }
  } catch {}

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
