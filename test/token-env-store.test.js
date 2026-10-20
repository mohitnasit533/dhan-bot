'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveAccessToken } = require('../token-env-store');

test('updates only the local Dhan access token setting', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dhan-env-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, '.env');
  fs.writeFileSync(envPath, 'PORT=3000\nDHAN_CLIENT_ID=123456\nDHAN_ACCESS_TOKEN=old-token-value-123456\nOTHER_SETTING=keep\n');

  saveAccessToken(envPath, 'new-token-value-123456');

  assert.equal(fs.readFileSync(envPath, 'utf8'), 'PORT=3000\nDHAN_CLIENT_ID=123456\nDHAN_ACCESS_TOKEN=new-token-value-123456\nOTHER_SETTING=keep\n');
  assert.equal(fs.existsSync(`${envPath}.tmp`), false);
});

test('rejects unsafe token data before changing the local environment file', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dhan-env-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, '.env');
  const original = 'DHAN_ACCESS_TOKEN=old-token-value-123456\n';
  fs.writeFileSync(envPath, original);

  assert.throws(() => saveAccessToken(envPath, 'attacker-token-123456\nOTHER_SETTING=bad'), /invalid access token/);
  assert.equal(fs.readFileSync(envPath, 'utf8'), original);
});
