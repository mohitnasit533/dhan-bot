'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppLogger, MAX_LOG_BYTES } = require('../app-logger');

test('writes bounded local logs and prevents newline log injection', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dhan-logs-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logger = createAppLogger(directory);

  logger.write('warning', 'line one\nforged entry', { symbol: 'RELIANCE' });

  const file = fs.readdirSync(directory)[0];
  const contents = fs.readFileSync(path.join(directory, file), 'utf8');
  assert.match(contents, /line one forged entry/);
  assert.equal(contents.split(/\r?\n/).filter(Boolean).length, 1);
});

test('does not append entries that would exceed the daily file limit', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dhan-logs-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(directory, `dhan-${today}.log`), Buffer.alloc(MAX_LOG_BYTES - 1));
  const logger = createAppLogger(directory);

  assert.throws(() => logger.write('info', 'entry'), /reached its .*byte limit/);
});

test('keeps Telegram disabled unless both settings are present and reports delivery errors', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dhan-logs-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount++;
    return Response.json({ ok: false }, { status: 200 });
  };
  const logger = createAppLogger(directory, {}, fetchImpl);

  assert.equal(await logger.alert('info', 'local only'), false);
  await assert.rejects(
    createAppLogger(directory, { TELEGRAM_BOT_TOKEN: 'token' }, fetchImpl).telegram('message'),
    /Configure both/
  );
  await assert.rejects(
    createAppLogger(directory, { TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: 'chat' }, fetchImpl).alert('warning', 'message'),
    /Telegram notification failed/
  );
  assert.equal(requestCount, 1);
});
