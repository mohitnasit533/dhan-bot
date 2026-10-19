'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isAllowedLocalHost, isSameOriginRequest } = require('../local-security');
const { findActiveSuperOrder, isTerminalSuperOrder, findReconciledOrder } = require('../live-order-guard');
const { createAutoSignalStore } = require('../auto-signal-store');

test('local API host check accepts loopback names and rejects remote or malformed hosts', () => {
  assert.equal(isAllowedLocalHost('localhost:3000'), true);
  assert.equal(isAllowedLocalHost('127.0.0.1:3000'), true);
  assert.equal(isAllowedLocalHost('[::1]:3000'), true);
  assert.equal(isAllowedLocalHost('attacker.example:3000'), false);
  assert.equal(isAllowedLocalHost('localhost.attacker.example:3000'), false);
  assert.equal(isAllowedLocalHost(undefined), false);
});

test('browser mutation origin must match the local request host', () => {
  assert.equal(isSameOriginRequest('http://localhost:3000', 'localhost:3000'), true);
  assert.equal(isSameOriginRequest('http://evil.example', 'localhost:3000'), false);
  assert.equal(isSameOriginRequest('not an origin', 'localhost:3000'), false);
});

test('pending and partially filled Dhan orders block another order for the same underlying', () => {
  const orders = [
    { tradingSymbol: 'RELIANCE 30 JUN 2800 PE', orderStatus: 'PART_TRADED' },
    { tradingSymbol: 'TCS 30 JUN 3200 CE', orderStatus: 'CANCELLED' }
  ];
  assert.equal(findActiveSuperOrder(orders, 'RELIANCE').orderStatus, 'PART_TRADED');
  assert.equal(findActiveSuperOrder(orders, 'TCS'), undefined);
  assert.equal(findActiveSuperOrder(orders, 'INFY'), undefined);
});

test('live reservation is reconciled only after Dhan reports a terminal order state', () => {
  const reservation = { correlationId: 'desk-123' };
  const pending = [{ correlationId: 'desk-123', orderStatus: 'PENDING' }];
  const closed = [{ correlationId: 'desk-123', orderStatus: 'CLOSED' }];
  assert.equal(isTerminalSuperOrder(findReconciledOrder(pending, reservation)), false);
  assert.equal(isTerminalSuperOrder(findReconciledOrder(closed, reservation)), true);
  assert.equal(findReconciledOrder([], reservation), undefined);
});

test('auto-trade signal deduplication survives a server restart', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dhan-auto-state-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'state.json');
  const firstRun = createAutoSignalStore(statePath);

  assert.equal(firstRun.remember('RELIANCE', '2026-10-20T09:45:00.000Z:BUY'), true);
  assert.equal(firstRun.remember('RELIANCE', '2026-10-20T09:45:00.000Z:BUY'), false);

  const restarted = createAutoSignalStore(statePath);
  assert.equal(restarted.remember('RELIANCE', '2026-10-20T09:45:00.000Z:BUY'), false);
  assert.equal(restarted.remember('RELIANCE', '2026-10-20T10:00:00.000Z:BUY'), true);
});
