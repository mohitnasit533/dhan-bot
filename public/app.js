'use strict';

const $ = (selector) => document.querySelector(selector);
const notice = $('#notice');
let activePreviewId = null;
let currentMode = 'PAPER';
let connected = false;
let scannerRefreshInFlight = false;

function showNotice(message, kind = '') {
  notice.textContent = message || '';
  notice.className = message ? `notice show ${kind}` : 'notice';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || `Request failed (${response.status}).`);
  }
  return data;
}

function formatPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? number.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function setConnected(value, profile) {
  connected = value;
  const status = $('#connection-status');
  status.classList.toggle('connected', connected);
  status.lastElementChild.textContent = connected ? `Connected${profile?.name ? ` · ${profile.name}` : ''}` : 'Not connected';
  $('#disconnect-button').classList.toggle('hidden', !connected);
  $('#connection-info').textContent = connected
    ? `Client ID ${profile?.clientId || ''}. Credentials remain in server memory only.`
    : 'Credentials are sent only to this local server and held in memory.';
}

async function refreshConnection() {
  const connection = await api('/api/connection');
  currentMode = connection.mode || 'PAPER';
  $('#mode-select').value = currentMode;
  $('#positions-mode').textContent = currentMode === 'PAPER' ? 'Paper positions' : 'Broker positions';
  setConnected(connection.connected, connection.profile);
  const settings = connection.settings || {};
  const form = $('#trade-settings');
  form.elements.lots.value = settings.lotSize ?? 1;
  form.elements.maxTrades.value = settings.maxTrades ?? 5;
  form.elements.autoTrade.checked = Boolean(connection.autoTrade);
  $('#trade-mode-label').textContent = connection.autoTrade ? 'Auto trade' : 'Manual confirmation';
}

function renderScanner(results = []) {
  $('#buy-count').textContent = String(results.filter((row) => row.signal === 'BUY').length);
  $('#sell-count').textContent = String(results.filter((row) => row.signal === 'SELL').length);
  const body = $('#scanner-body');
  if (!results.length) {
    body.innerHTML = `<tr><td colspan="9" class="empty">${connected ? 'No scanner data returned.' : 'Connect Dhan to see scanner results.'}</td></tr>`;
    return;
  }
  body.innerHTML = results.map((row) => {
    const signal = row.signal || 'WATCH';
    const badgeClass = signal === 'BUY' ? 'buy' : signal === 'SELL' ? 'sell' : 'watch';
    const cpr = row.cpr
      ? `${row.cpr.narrow ? 'Narrow' : 'Wide'} · ${Number(row.cpr.widthPct).toFixed(2)}%`
      : 'Unavailable';
    const action = ['BUY', 'SELL'].includes(signal)
      ? `<button class="small-button primary preview-button" data-symbol="${escapeHtml(row.symbol)}" data-signal="${escapeHtml(signal)}" type="button">Preview</button>`
      : '<span class="muted">—</span>';
    return `<tr>
      <td><strong>${escapeHtml(row.symbol)}</strong></td>
      <td>${formatPrice(row.price)}</td>
      <td>${formatPrice(row.ema21)} / ${formatPrice(row.ema34)}</td>
      <td>${formatPrice(row.vwap)}</td>
      <td>${escapeHtml(cpr)}</td>
      <td>${escapeHtml(row.trend || '—')}</td>
      <td><span class="pill ${badgeClass}">${escapeHtml(signal)}</span></td>
      <td>${escapeHtml(row.setup || '—')}</td>
      <td>${action}</td>
    </tr>`;
  }).join('');
}

function renderPositions(positions = []) {
  $('#position-count').textContent = `${positions.length} / 5`;
  const body = $('#positions-body');
  if (!positions.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty">${currentMode === 'PAPER' ? 'No open paper positions.' : 'No open broker positions.'}</td></tr>`;
    return;
  }
  body.innerHTML = positions.map((trade) => {
    const paperClose = currentMode === 'PAPER'
      ? `<button class="small-button danger close-button" data-symbol="${escapeHtml(trade.symbol)}" type="button">Close</button>`
      : '';
    const pnl = Number(trade.pnlPct);
    return `<tr>
      <td><strong>${escapeHtml(trade.symbol || trade.tradingSymbol || trade.securityName || '—')}</strong></td>
      <td>${escapeHtml(trade.side || trade.transactionType || '—')}</td>
      <td>${escapeHtml(trade.quantity ?? trade.netQty ?? '—')}</td>
      <td>${formatPrice(trade.entryPrice ?? trade.averagePrice)}</td>
      <td>${formatPrice(trade.currentPrice ?? trade.lastPrice)}</td>
      <td>${Number.isFinite(pnl) ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%` : '—'}</td>
      <td>${trade.stopPrice ? `${formatPrice(trade.stopPrice)} / ${formatPrice(trade.targetPrice)}` : '—'}</td>
      <td>${paperClose}</td>
    </tr>`;
  }).join('');
}

async function refreshScanner(showErrors = true) {
  if (scannerRefreshInFlight) return;
  scannerRefreshInFlight = true;
  $('#refresh-button').disabled = true;
  try {
    const data = await api('/api/scanner');
    renderScanner(data.results || []);
    const positions = currentMode === 'PAPER' ? (data.activePositions || []) : (data.brokerPositions || []);
    renderPositions(positions);
    $('#scanner-caption').textContent = data.connected
      ? `${data.strategy || 'Live market data'} · ${data.mode || currentMode} mode`
      : (data.message || 'Connect your account to load market data.');
    $('#updated-at').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    if (data.autoTrade?.lastError) showNotice(`Auto-trade: ${data.autoTrade.lastError}`, 'error');
    return data;
  } catch (error) {
    if (showErrors) showNotice(error.message, 'error');
    throw error;
  } finally {
    scannerRefreshInFlight = false;
    $('#refresh-button').disabled = false;
  }
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

$('#connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = formValues(form);
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const data = await api('/api/connect', { method: 'POST', body: JSON.stringify(fields) });
    form.elements.accessToken.value = '';
    setConnected(true, data.profile);
    showNotice(data.message || 'Connected to Dhan.', 'success');
    await refreshConnection();
    await refreshScanner();
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#disconnect-button').addEventListener('click', async () => {
  if (!confirm('Disconnect Dhan? This also returns the app to Paper mode.')) return;
  try {
    await api('/api/disconnect', { method: 'POST', body: '{}' });
    activePreviewId = null;
    $('#preview-card').classList.add('hidden');
    await refreshConnection();
    await refreshScanner();
    showNotice('Dhan disconnected. Trading mode returned to Paper.', 'success');
  } catch (error) {
    showNotice(error.message, 'error');
  }
});

$('#mode-select').addEventListener('change', async (event) => {
  const requestedMode = event.target.value;
  if (requestedMode === 'LIVE' && !confirm('Enable LIVE mode? This allows confirmed orders to be submitted to Dhan.')) {
    event.target.value = currentMode;
    return;
  }
  try {
    const data = await api('/api/mode', { method: 'POST', body: JSON.stringify({ mode: requestedMode }) });
    currentMode = data.mode;
    $('#positions-mode').textContent = currentMode === 'PAPER' ? 'Paper positions' : 'Broker positions';
    activePreviewId = null;
    $('#preview-card').classList.add('hidden');
    showNotice(data.message, 'success');
    await refreshScanner();
  } catch (error) {
    event.target.value = currentMode;
    showNotice(error.message, 'error');
  }
});

$('#trade-settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = formValues(event.currentTarget);
  const payload = {
    enabled: event.currentTarget.elements.autoTrade.checked,
    lotSize: Number(values.lots),
    maxTrades: Number(values.maxTrades)
  };
  try {
    const data = await api('/api/auto-trade', { method: 'POST', body: JSON.stringify(payload) });
    $('#trade-mode-label').textContent = data.enabled ? 'Auto trade' : 'Manual confirmation';
    if (data.enabled) {
      $('#scan-auto-refresh').checked = true;
      try {
        localStorage.setItem('dhan-auto-scan', 'true');
      } catch {}
      await refreshScanner();
    }
    showNotice(data.message, 'success');
  } catch (error) {
    showNotice(error.message, 'error');
  }
});

$('#scanner-body').addEventListener('click', async (event) => {
  const button = event.target.closest('.preview-button');
  if (!button) return;
  button.disabled = true;
  try {
    const form = formValues($('#trade-settings'));
    const data = await api('/api/trade/preview', {
      method: 'POST',
      body: JSON.stringify({
        symbol: button.dataset.symbol,
        signal: button.dataset.signal,
        lots: Number(form.lots)
      })
    });
    activePreviewId = data.previewId;
    $('#preview-card').classList.remove('hidden');
    $('#preview-content').innerHTML = `<div class="preview-grid">${Object.entries(data.preview || {}).map(([key, value]) => (
      `<div class="preview-item"><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`
    )).join('')}</div>`;
    $('#preview-warning').textContent = data.warning || '';
    $('#execute-order').textContent = data.mode === 'LIVE' ? 'Confirm and submit LIVE order' : 'Confirm paper trade';
    $('#preview-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    showNotice(`Preview ready for ${button.dataset.symbol}. It expires in two minutes.`, 'success');
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#execute-order').addEventListener('click', async () => {
  if (!activePreviewId) return;
  const live = currentMode === 'LIVE';
  const message = live
    ? 'Submit this LIVE order to Dhan? This may place a real trade.'
    : 'Record this paper trade?';
  if (!confirm(message)) return;
  const button = $('#execute-order');
  button.disabled = true;
  try {
    const data = await api('/api/trade/execute', {
      method: 'POST',
      body: JSON.stringify({ previewId: activePreviewId })
    });
    activePreviewId = null;
    $('#preview-card').classList.add('hidden');
    showNotice(data.message || 'Order confirmed.', 'success');
    await refreshScanner();
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#positions-body').addEventListener('click', async (event) => {
  const button = event.target.closest('.close-button');
  if (!button || !confirm(`Close the paper position for ${button.dataset.symbol}?`)) return;
  try {
    const data = await api('/api/trade/close', {
      method: 'POST',
      body: JSON.stringify({ symbol: button.dataset.symbol })
    });
    showNotice(data.message, 'success');
    await refreshScanner();
  } catch (error) {
    showNotice(error.message, 'error');
  }
});

$('#refresh-button').addEventListener('click', () => refreshScanner().catch(() => {}));
$('#cancel-preview').addEventListener('click', () => {
  activePreviewId = null;
  $('#preview-card').classList.add('hidden');
});

async function initialize() {
  try {
    await refreshConnection();
    await refreshScanner(false);
  } catch (error) {
    showNotice(error.message, 'error');
    $('#scanner-caption').textContent = 'The local server is running, but scanner data is unavailable.';
  }
}

initialize();
window.setInterval(() => {
  if (connected && $('#scan-auto-refresh').checked) refreshScanner(false).catch(() => {});
}, 1000);

try {
  $('#scan-auto-refresh').checked = localStorage.getItem('dhan-auto-scan') !== 'false';
} catch {}

$('#scan-auto-refresh').addEventListener('change', (event) => {
  try {
    localStorage.setItem('dhan-auto-scan', String(event.currentTarget.checked));
  } catch {}
  if (event.currentTarget.checked && connected) refreshScanner().catch(() => {});
  showNotice(event.currentTarget.checked
    ? 'Auto scan enabled: scanner refreshes every second, subject to Dhan API rate limits.'
    : 'Auto scan disabled: use Refresh scanner when you want new data.', 'success');
});
