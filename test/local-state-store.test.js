'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalStateStore } = require('../local-state-store');
const { DEFAULT_SETTINGS, validateTradeSettings } = require('../risk-controls');

test('persists open and closed trades and restores them after a restart', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dhan-local-state-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'state.json');
  const store = createLocalStateStore(statePath, DEFAULT_SETTINGS, validateTradeSettings);
  store.save({
    settings: { ...DEFAULT_SETTINGS, stopLossInr: 200, targetInr: 300, maxDailyLossInr: 1000 },
    activeTrades: [{ symbol: 'RELIANCE', status: 'OPEN', entryPrice: 100, quantity: 10, openedAt: '2026-10-20T09:00:00Z' }],
    closedTrades: [{ symbol: 'TCS', status: 'CLOSED', entryPrice: 50, quantity: 2, openedAt: '2026-10-20T09:00:00Z', closedAt: '2026-10-20T09:30:00Z' }],
    liveTrades: []
  });

  const restored = createLocalStateStore(statePath, DEFAULT_SETTINGS, validateTradeSettings).getState();
  assert.equal(restored.activeTrades.length, 1);
  assert.equal(restored.closedTrades.length, 1);
  assert.equal(restored.settings.stopLossInr, 200);
});

test('does not overwrite or silently reset state with an unsupported schema', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dhan-local-state-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'state.json');
  const original = JSON.stringify({ version: 1, activeTrades: [{ symbol: 'KEEP' }] });
  fs.writeFileSync(statePath, original);

  assert.throws(() => createLocalStateStore(statePath, DEFAULT_SETTINGS, validateTradeSettings), /invalid format/);
  assert.equal(fs.readFileSync(statePath, 'utf8'), original);
});

test('reports corrupt state clearly without replacing the file', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dhan-local-state-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'state.json');
  fs.writeFileSync(statePath, '{');

  assert.throws(() => createLocalStateStore(statePath, DEFAULT_SETTINGS, validateTradeSettings), /state is corrupt/);
  assert.equal(fs.readFileSync(statePath, 'utf8'), '{');
});

test('rejects null, nonpositive, and malformed trade values', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dhan-local-state-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 2,
    settings: DEFAULT_SETTINGS,
    activeTrades: [{ symbol: 'RELIANCE', status: 'OPEN', entryPrice: null, quantity: null, openedAt: 'bad date' }],
    closedTrades: [],
    liveTrades: []
  }));

  assert.throws(() => createLocalStateStore(statePath, DEFAULT_SETTINGS, validateTradeSettings), /invalid trades/);
});
