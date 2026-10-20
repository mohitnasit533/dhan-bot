'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDhanMcp } = require('../dhan-mcp');

function createFakeMcp() {
  let provider;
  let connected = false;
  const tools = [
    {
      name: 'market_data_agent_tool',
      description: 'Fetch quotes and OHLC data for requested securities.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        properties: {
          action: { type: 'string', enum: ['get_ltp', 'get_ohlc', 'get_quote'] },
          payload: {
            type: 'object',
            properties: {
              NSE_EQ: { type: 'array' },
              NSE_FNO: { type: 'array' },
              BSE_EQ: { type: 'array' }
            }
          }
        }
      }
    },
    {
      name: 'place_order',
      description: 'Submit a Dhan order.',
      annotations: { readOnlyHint: false },
      inputSchema: { properties: { securityId: { type: 'string' } } }
    }
  ];
  const calls = [];
  class FakeTransport {
    constructor(_url, options) {
      provider = options.authProvider;
    }

    async finishAuth(code) {
      assert.equal(code, 'test-code');
      await provider.saveTokens({ access_token: 'test-access-token', token_type: 'Bearer' });
    }

    async close() {}
  }
  class FakeClient {
    constructor() {}

    async connect() {
      if (!provider.tokens()) {
        const state = await provider.state();
        await provider.redirectToAuthorization(new URL(`https://mcp.dhan.co/authorize?state=${state}`));
        throw new Error('Authorization required.');
      }
      connected = true;
    }

    async listTools() {
      assert.equal(connected, true);
      return { tools };
    }

    async callTool(call) {
      assert.equal(connected, true);
      calls.push(call);
      return { content: [{ type: 'text', text: 'quote response' }] };
    }

    async close() {
      connected = false;
    }
  }
  return { Client: FakeClient, Transport: FakeTransport, getProvider: () => provider, calls };
}

test('Dhan MCP OAuth begins with an origin-checked authorization URL and no token exposure', async () => {
  const fake = createFakeMcp();
  const mcp = createDhanMcp(fake);
  const result = await mcp.connect();

  assert.equal(new URL(result.authorizationUrl).origin, 'https://mcp.dhan.co');
  assert.equal(result.authorized, false);
  assert.equal(Object.hasOwn(result, 'access_token'), false);
});

test('Dhan MCP rejects invalid OAuth state before exchanging the code', async () => {
  const fake = createFakeMcp();
  const mcp = createDhanMcp(fake);
  const pending = await mcp.connect();
  const state = new URL(pending.authorizationUrl).searchParams.get('state');

  await assert.rejects(
    mcp.finishAuthorization(new URLSearchParams('state=wrong&code=test-code')),
    /state did not match/
  );
  assert.equal(mcp.getStatus().authorized, false);
  const status = await mcp.finishAuthorization(new URLSearchParams(`state=${state}&code=test-code`));
  assert.equal(status.connected, true);
  assert.equal(status.authorized, true);
});

test('Dhan MCP rejects authorization URLs outside the Dhan origin', async () => {
  const fake = createFakeMcp();
  const mcp = createDhanMcp(fake);
  await mcp.connect();

  assert.throws(
    () => fake.getProvider().redirectToAuthorization(new URL('https://attacker.example/authorize')),
    /unexpected OAuth authorization URL/
  );
});

test('Dhan MCP completes PKCE callback and lists only annotated read-only market tools as candidates', async () => {
  const fake = createFakeMcp();
  const mcp = createDhanMcp(fake);
  const pending = await mcp.connect();
  const state = new URL(pending.authorizationUrl).searchParams.get('state');
  const status = await mcp.finishAuthorization(new URLSearchParams(`state=${state}&code=test-code`));

  assert.equal(status.connected, true);
  assert.equal(status.authorized, true);
  assert.equal(status.toolCount, 2);
  assert.deepEqual(status.marketDataTools.map((tool) => tool.name), ['market_data_agent_tool']);
  assert.deepEqual(status.marketDataTools[0].actionOptions, ['get_ltp', 'get_ohlc', 'get_quote']);
  assert.equal(JSON.stringify(status).includes('test-access-token'), false);

  await mcp.callMarketData('get_quote', { NSE_EQ: [13] });
  assert.deepEqual(fake.calls[0].arguments, { action: 'get_quote', payload: { NSE_EQ: [13] } });
  await assert.rejects(mcp.callMarketData('place_order', { NSE_EQ: [13] }), /Unsupported MCP market-data action/);
  await assert.rejects(mcp.callMarketData('get_quote', { orders: [13] }), /positive security IDs/);

  mcp.disconnect();
  assert.equal(mcp.getStatus().authorized, false);
});
