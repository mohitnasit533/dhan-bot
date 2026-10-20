'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dhan = require('../dhan');

test('renews a Dhan Web access token with the documented request and uses the replacement', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/profile')) {
      return new Response(JSON.stringify({
        data: { dhanClientId: '123456', dhanClientName: 'Test account' }
      }), { status: 200 });
    }
    if (url.endsWith('/RenewToken')) {
      return new Response(JSON.stringify({
        accessToken: 'replacement-access-token-123456',
        expiryTime: '2026-10-21T19:45:00'
      }), { status: 200 });
    }
    if (url.endsWith('/positions')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    throw new Error(`Unexpected Dhan request: ${url}`);
  };

  try {
    await dhan.connect('123456', 'original-access-token-123456');
    const renewed = await dhan.renewAccessToken();
    await dhan.getPositions();

    assert.equal(renewed.accessToken, 'replacement-access-token-123456');
    assert.equal(renewed.expiryTime, '2026-10-21T19:45:00');
    const renewalRequest = requests.find(({ url }) => url.endsWith('/RenewToken'));
    assert.equal(renewalRequest.options.method, 'GET');
    assert.equal(renewalRequest.options.headers['access-token'], 'original-access-token-123456');
    assert.equal(renewalRequest.options.headers.dhanClientId, '123456');
    const positionsRequest = requests.find(({ url }) => url.endsWith('/positions'));
    assert.equal(positionsRequest.options.headers['access-token'], 'replacement-access-token-123456');
  } finally {
    dhan.disconnect();
    global.fetch = originalFetch;
  }
});

test('does not replace the saved Dhan token when renewal fails', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.endsWith('/profile')) {
      return new Response(JSON.stringify({
        data: { dhanClientId: '123456', dhanClientName: 'Test account' }
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      status: 'failure',
      remarks: 'Token cannot be renewed.'
    }), { status: 401 });
  };

  try {
    await dhan.connect('123456', 'original-access-token-123456');
    await assert.rejects(dhan.renewAccessToken(), /Token cannot be renewed/);
  } finally {
    dhan.disconnect();
    global.fetch = originalFetch;
  }
});

test('sets the chosen static IP through Dhan POST with the verified credentials', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/profile')) {
      return new Response(JSON.stringify({
        data: { dhanClientId: '123456', dhanClientName: 'Test account' }
      }), { status: 200 });
    }
    if (url.endsWith('/ip/setIP')) {
      return new Response(JSON.stringify({ status: 'success' }), { status: 200 });
    }
    throw new Error(`Unexpected Dhan request: ${url}`);
  };

  try {
    await dhan.connect('123456', 'original-access-token-123456');
    await dhan.setStaticIp('203.0.113.10', 'SECONDARY');
    const request = requests.find(({ url }) => url.endsWith('/ip/setIP'));
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['access-token'], 'original-access-token-123456');
    assert.equal(request.options.headers['client-id'], '123456');
    assert.equal(request.options.headers.Accept, 'application/json');
    assert.deepEqual(JSON.parse(request.options.body), {
      dhanClientId: '123456',
      ip: '203.0.113.10',
      ipFlag: 'SECONDARY'
    });
    await assert.rejects(dhan.setStaticIp('not-an-ip', 'PRIMARY'), { statusCode: 400 });
    await assert.rejects(dhan.setStaticIp('203.0.113.11', 'INVALID'), { statusCode: 400 });
  } finally {
    dhan.disconnect();
    global.fetch = originalFetch;
  }
});
