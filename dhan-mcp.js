'use strict';

const { randomBytes } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const MCP_URL = 'https://mcp.dhan.co/mcp';
const MCP_ORIGIN = new URL(MCP_URL).origin;

function summarizeTool(tool) {
  const properties = tool.inputSchema?.properties || {};
  return {
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description.slice(0, 500) : '',
    readOnlyHint: tool.annotations?.readOnlyHint === true,
    inputFields: Object.keys(properties),
    actionOptions: Array.isArray(properties.action?.enum) ? properties.action.enum.slice(0, 30) : [],
    payloadFields: Object.keys(properties.payload?.properties || {})
  };
}

function isMarketDataTool(tool) {
  const summary = summarizeTool(tool);
  const identity = `${summary.name} ${summary.description}`.toLowerCase();
  return (
    summary.readOnlyHint
    && /(market|quote|ohlc|candle|histor|option.?chain|expiry|instrument|security|scrip)/i.test(identity)
    && !/(order|trade|position|fund|margin|portfolio|cancel|modify|place|execute)/i.test(identity)
  ) || summary.name === 'market_data_agent_tool';
}

function createDhanMcp(options = {}) {
  const url = options.url || MCP_URL;
  const redirectUrl = options.redirectUrl || 'http://127.0.0.1:3000/api/mcp/callback';
  const ClientConstructor = options.Client || Client;
  const TransportConstructor = options.Transport || StreamableHTTPClientTransport;
  let clientInformation;
  let oauthTokens;
  let codeVerifier;
  let discoveryState;
  let pendingState;
  let pendingAuthorizationUrl;
  let tools = [];
  let connectedAt = null;
  let connecting = false;

  const provider = {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return {
        client_name: 'Dhan Local Dashboard',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      };
    },
    state() {
      if (!pendingState) pendingState = randomBytes(32).toString('base64url');
      return pendingState;
    },
    clientInformation() {
      return clientInformation;
    },
    saveClientInformation(value) {
      clientInformation = value;
    },
    tokens() {
      return oauthTokens;
    },
    saveTokens(value) {
      oauthTokens = value;
    },
    redirectToAuthorization(authorizationUrl) {
      const destination = new URL(authorizationUrl);
      if (destination.protocol !== 'https:' || destination.origin !== MCP_ORIGIN) {
        throw new Error('Dhan MCP returned an unexpected OAuth authorization URL.');
      }
      pendingAuthorizationUrl = destination.toString();
    },
    saveCodeVerifier(value) {
      codeVerifier = value;
    },
    codeVerifier() {
      if (!codeVerifier) throw new Error('Dhan MCP OAuth code verifier is unavailable.');
      return codeVerifier;
    },
    saveDiscoveryState(value) {
      discoveryState = value;
    },
    discoveryState() {
      return discoveryState;
    },
    invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'client') clientInformation = undefined;
      if (scope === 'all' || scope === 'tokens') oauthTokens = undefined;
      if (scope === 'all' || scope === 'verifier') codeVerifier = undefined;
      if (scope === 'all' || scope === 'discovery') discoveryState = undefined;
    }
  };

  async function connectAndListTools() {
    const transport = new TransportConstructor(new URL(url), { authProvider: provider });
    const client = new ClientConstructor({ name: 'dhan-local-dashboard', version: '1.0.0' });
    try {
      await client.connect(transport);
      const result = await client.listTools();
      tools = Array.isArray(result.tools) ? result.tools : [];
      connectedAt = new Date().toISOString();
      return getStatus();
    } finally {
      await client.close();
    }
  }

  async function callMarketData(action, payload) {
    if (connecting) throw new Error('A Dhan MCP connection attempt is already in progress.');
    if (!oauthTokens?.access_token) throw new Error('Connect and authorize Dhan MCP first.');
    const tool = tools.find((candidate) => candidate.name === 'market_data_agent_tool');
    if (!tool) throw new Error('Dhan MCP did not expose its market_data_agent_tool.');
    if (!['get_ltp', 'get_ohlc', 'get_quote'].includes(action)) {
      throw new Error('Unsupported MCP market-data action. Use get_ltp, get_ohlc, or get_quote.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Market-data payload must be an object.');
    }
    const toolSchema = tool.inputSchema?.properties || {};
    const payloadSchema = toolSchema.payload?.properties || {};
    const permittedSegments = ['NSE_EQ', 'NSE_FNO', 'BSE_EQ'];
    for (const [segment, securityIds] of Object.entries(payload)) {
      if (!permittedSegments.includes(segment)
        || !Array.isArray(securityIds)
        || !securityIds.length
        || securityIds.length > 100
        || securityIds.some((securityId) => !Number.isSafeInteger(Number(securityId)) || Number(securityId) <= 0)) {
        throw new Error('Market-data requests must contain 1-100 positive security IDs per supported segment.');
      }
    }
    if (!Object.keys(payload).length) throw new Error('Market-data payload must include at least one exchange segment.');

    const actionSchema = toolSchema.action || {};
    const allowedAction = actionSchema.enum;
    if (!Array.isArray(allowedAction) || !allowedAction.includes(action)) {
      throw new Error('The connected MCP tool schema does not explicitly allow this market-data action.');
    }
    for (const key of Object.keys(payload)) {
      if (Object.keys(payloadSchema).length && !(key in payloadSchema)) {
        throw new Error(`The connected MCP tool schema does not allow payload field ${key}.`);
      }
    }

    const client = new ClientConstructor({ name: 'dhan-local-dashboard', version: '1.0.0' });
    const transport = new TransportConstructor(new URL(url), { authProvider: provider });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: tool.name, arguments: { action, payload } });
      if (result.isError) throw new Error('Dhan MCP market-data request failed.');
      return result;
    } finally {
      await client.close();
    }
  }

  async function connect() {
    if (connecting) throw new Error('A Dhan MCP connection attempt is already in progress.');
    connecting = true;
    pendingAuthorizationUrl = null;
    pendingState = null;
    try {
      try {
        return { ...await connectAndListTools(), authorizationUrl: null };
      } catch (error) {
        connectedAt = null;
        tools = [];
        if (pendingAuthorizationUrl) {
          return {
            ...getStatus(),
            authorizationUrl: pendingAuthorizationUrl
          };
        }
        throw error;
      }
    } finally {
      connecting = false;
    }
  }

  async function finishAuthorization(params) {
    if (connecting) throw new Error('A Dhan MCP connection attempt is already in progress.');
    const state = params.get('state');
    if (!pendingState || !state || state !== pendingState) {
      throw new Error('Dhan MCP authorization state did not match. Start the connection again.');
    }
    if (params.has('error')) {
      pendingState = null;
      pendingAuthorizationUrl = null;
      codeVerifier = undefined;
      throw new Error('Dhan MCP authorization was not completed.');
    }
    const issuer = params.get('iss');
    if (issuer && issuer !== new URL(url).origin) {
      pendingState = null;
      pendingAuthorizationUrl = null;
      codeVerifier = undefined;
      throw new Error('Dhan MCP authorization issuer did not match.');
    }
    const code = params.get('code');
    if (!code || code.length > 4096) throw new Error('Dhan MCP did not return a valid authorization code.');

    connecting = true;
    const transport = new TransportConstructor(new URL(url), { authProvider: provider });
    try {
      await transport.finishAuth(code);
    } finally {
      try {
        await transport.close();
      } finally {
        connecting = false;
        pendingState = null;
        pendingAuthorizationUrl = null;
        codeVerifier = undefined;
      }
    }
    return connectAndListTools();
  }

  function disconnect() {
    oauthTokens = undefined;
    clientInformation = undefined;
    codeVerifier = undefined;
    discoveryState = undefined;
    pendingState = null;
    pendingAuthorizationUrl = null;
    tools = [];
    connectedAt = null;
  }

  function getStatus() {
    const catalog = tools.map(summarizeTool);
    return {
      connected: Boolean(connectedAt),
      authorized: Boolean(oauthTokens?.access_token),
      connectedAt,
      toolCount: catalog.length,
      marketDataTools: tools.filter(isMarketDataTool).map(summarizeTool),
      tools: catalog
    };
  }

  return { connect, finishAuthorization, callMarketData, disconnect, getStatus };
}

module.exports = { createDhanMcp, isMarketDataTool };
