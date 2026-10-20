'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createMarketSafety,
  parseTradingHolidays,
  parseBanCsv
} = require('../market-safety');

test('parses NSE holiday dates from trading-date fields', () => {
  assert.deepEqual(parseTradingHolidays({
    data: { FO: [{ tradingDate: '2026-10-21' }, { tradingDate: '22-Oct-2026' }] }
  }), ['2026-10-21', '2026-10-22']);
});

test('rejects malformed holiday and F&O ban data', () => {
  assert.throws(() => parseTradingHolidays({ data: [{ holiday: 'unknown' }] }), /no valid trading holiday/);
  assert.throws(() => parseTradingHolidays({ data: [{ date: '2026-99-99' }] }), /no valid trading holiday/);
  assert.throws(() => parseBanCsv('date,remarks\n'), /no symbol column/);
  assert.deepEqual(parseBanCsv('Symbol,Date\n'), []);
});

test('uses injected NSE responses and blocks an active ban-listed symbol', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dhan-market-safety-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('/market-data/')) {
      return new Response('', { status: 200, headers: { 'set-cookie': 'session=local; Path=/' } });
    }
    if (url.includes('holiday-master')) {
      return Response.json({ data: { FO: [{ tradingDate: '2026-10-21' }] } });
    }
    return Response.json({ data: [{ symbol: 'RELIANCE' }] });
  };
  const store = createMarketSafety({
    statePath: path.join(directory, 'state.json'),
    fetchImpl,
    now: () => new Date('2026-10-20T10:00:00Z').getTime()
  });
  await store.refresh(true);
  assert.ok(urls.some((url) => url.includes('holiday-master')));
  await assert.rejects(store.assertCanTrade('RELIANCE', new Date('2026-10-20T10:00:00Z')), /F&O ban list/);
});
