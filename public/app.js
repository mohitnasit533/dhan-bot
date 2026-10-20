'use strict';

const $ = (selector) => document.querySelector(selector);
const notice = $('#notice');
let activePreviewId = null;
let currentMode = 'PAPER';
let connected = false;
let scannerRefreshInFlight = false;
let autoTradeEnabled = false;
let maxOpenTrades = 5;
let latestScannerResults = [];
let scannerRenderSignature = '';

function showNotice(message, kind = '') {
  notice.textContent = message || '';
  notice.className = message ? `notice show ${kind}` : 'notice';
}

function updateScanIndicator(busy = false) {
  const indicator = $('#scan-indicator');
  const enabled = Boolean($('#scan-auto-refresh')?.checked);
  indicator.classList.toggle('on', enabled && connected);
  indicator.classList.toggle('busy', busy);
  indicator.querySelector('span').textContent = busy ? 'Updating…' : enabled ? 'Auto scan on' : 'Auto scan off';
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

function setConnected(value, profile, tokenRenewal) {
  connected = value;
  const status = $('#connection-status');
  status.classList.toggle('connected', connected);
  status.lastElementChild.textContent = connected ? `Connected${profile?.name ? ` · ${profile.name}` : ''}` : 'Not connected';
  $('#disconnect-button').classList.toggle('hidden', !connected);
  const form = $('#connect-form');
  form.querySelectorAll('label, button[type="submit"]').forEach((element) => {
    element.classList.toggle('hidden', connected);
  });
  $('#connection-info').textContent = connected
    ? `Client ID ${profile?.clientId || ''}. ${tokenRenewal?.message || 'Credentials remain on this computer.'}`
    : 'Credentials are sent only to this local server.';
}

async function refreshConnection() {
  const connection = await api('/api/connection');
  currentMode = connection.mode || 'PAPER';
  $('#mode-select').value = currentMode;
  $('#positions-mode').textContent = currentMode === 'PAPER' ? 'Paper positions' : 'Broker positions';
  setConnected(connection.connected, connection.profile, connection.tokenRenewal);
  const settings = connection.settings || {};
  const form = $('#trade-settings');
  form.elements.lots.value = settings.lotSize ?? 1;
  form.elements.maxTrades.value = settings.maxTrades ?? 5;
  maxOpenTrades = settings.maxTrades ?? 5;
  autoTradeEnabled = Boolean(connection.autoTrade);
  form.elements.autoTrade.checked = Boolean(connection.autoTrade);
  $('#trade-mode-label').textContent = connection.autoTrade ? 'Auto trade' : 'Manual confirmation';
}

function renderScanner(results = []) {
  latestScannerResults = results;
  for (const row of results) {
    if (row.dataError) row.setup = row.dataError;
  }
  $('#buy-count').textContent = String(results.filter((row) => row.signal === 'BUY').length);
  $('#sell-count').textContent = String(results.filter((row) => row.signal === 'SELL').length);
  const body = $('#scanner-body');
  const search = ($('#scanner-filter')?.value || '').trim().toUpperCase();
  const visibleResults = search ? results.filter((row) => row.symbol.includes(search)) : results;
  renderSignalCards(visibleResults.filter((row) => ['BUY', 'SELL'].includes(row.signal)));
  if (!visibleResults.length) {
    scannerRenderSignature = '';
    body.innerHTML = `<tr><td colspan="10" class="empty">${connected ? 'No scanner data returned.' : 'Connect Dhan to see scanner results.'}</td></tr>`;
    return;
  }
  const signature = JSON.stringify(visibleResults.map((row) => [
    row.symbol, row.turnover, row.ema21, row.ema34, row.vwap, row.cpr, row.trend, row.signal, row.setup, row.dataError
  ]));
  if (signature !== scannerRenderSignature) {
    body.innerHTML = visibleResults.map((row) => {
    const signal = row.signal || 'WATCH';
    const badgeClass = signal === 'BUY' ? 'buy' : signal === 'SELL' ? 'sell' : 'watch';
    const cpr = row.cpr
      ? `${row.cpr.narrow ? 'Narrow' : 'Wide'} · ${Number(row.cpr.widthPct).toFixed(2)}%`
      : 'Unavailable';
    const action = ['BUY', 'SELL'].includes(signal)
      ? `<button class="small-button primary preview-button" data-symbol="${escapeHtml(row.symbol)}" data-signal="${escapeHtml(signal)}" type="button">Preview</button>`
      : '<span class="muted">—</span>';
    return `<tr data-symbol="${escapeHtml(row.symbol)}">
      <td><strong>${escapeHtml(row.symbol)}</strong></td>
      <td>${Number.isFinite(Number(row.turnover)) ? (Number(row.turnover) / 10000000).toFixed(1) : '—'}</td>
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
    scannerRenderSignature = signature;
  }
  const rowsBySymbol = new Map(Array.from(body.querySelectorAll('tr[data-symbol]'))
    .map((row) => [row.dataset.symbol, row]));
  for (const row of visibleResults) {
    const rendered = rowsBySymbol.get(row.symbol);
    if (rendered) {
      const turnover = Number.isFinite(Number(row.turnover)) ? (Number(row.turnover) / 10000000).toFixed(1) : '—';
      if (rendered.cells[1].textContent !== turnover) rendered.cells[1].textContent = turnover;
      if (rendered.cells[2].textContent !== formatPrice(row.price)) rendered.cells[2].textContent = formatPrice(row.price);
    }
  }
}

function renderSignalCards(signals) {
  const container = $('#signal-cards');
  if (!connected) {
    container.innerHTML = '<p class="note">Connect Dhan to see current signals.</p>';
    return;
  }
  if (!signals.length) {
    container.innerHTML = '<p class="note">No confirmed signals right now. The scanner is watching all liquid stocks.</p>';
    return;
  }
  container.innerHTML = signals.slice(0, 8).map((row) => {
    const bullish = row.signal === 'BUY';
    const cprWidth = Number(row.cpr?.widthPct);
    const cprText = Number.isFinite(cprWidth) ? `${cprWidth.toFixed(2)}%` : 'Unavailable';
    const vwapText = formatPrice(row.vwap);
    const cprRange = row.cpr
      ? `${formatPrice(row.cpr.top)} / ${formatPrice(row.cpr.bottom)}`
      : 'Unavailable';
    return `<article class="signal-card ${bullish ? 'buy' : 'sell'}">
      <div class="signal-title"><strong>${escapeHtml(row.symbol)}</strong><span>${formatPrice(row.price)}</span></div>
      <p class="note">${bullish ? 'Bullish: sell a put' : 'Bearish: sell a call'}</p>
      <div class="signal-data">
        <div>VWAP<b>${vwapText}</b></div><div>CPR width<b>${cprText}</b></div>
        <div>EMA 21 / 34<b>${formatPrice(row.ema21)} / ${formatPrice(row.ema34)}</b></div>
        <div>Turnover today<b>${(Number(row.turnover || 0) / 10000000).toFixed(1)} Cr</b></div>
        <div>CPR top / bottom<b>${cprRange}</b></div><div>Setup<b>${escapeHtml(row.setup || 'WAIT')}</b></div>
      </div>
      <button class="small-button primary preview-button" data-symbol="${escapeHtml(row.symbol)}" data-signal="${escapeHtml(row.signal)}" type="button">Preview order</button>
    </article>`;
  }).join('');
}

function renderPositions(positions = []) {
  $('#position-count').textContent = `${positions.length} / ${maxOpenTrades}`;
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
  $('#scanner-card').classList.add('scanning');
  updateScanIndicator(true);
  $('#refresh-button').disabled = true;
  try {
    const data = await api('/api/scanner');
    renderScanner(data.results || []);
    const positions = currentMode === 'PAPER' ? (data.activePositions || []) : (data.brokerPositions || []);
    renderPositions(positions);
    $('#scanner-caption').textContent = data.connected
      ? `${data.strategy || 'Live market data'} · ${data.mode || currentMode} mode`
      : (data.message || 'Connect your account to load market data.');
    const quoteTime = data.quotesUpdatedAt ? new Date(data.quotesUpdatedAt) : new Date();
    $('#updated-at').textContent = `Cash prices ${quoteTime.toLocaleTimeString()} · ${data.results?.length || 0} stocks`;
    if (data.autoTrade?.lastError) showNotice(`Auto-trade: ${data.autoTrade.lastError}`, 'error');
    return data;
  } catch (error) {
    if (showErrors) showNotice(error.message, 'error');
    throw error;
  } finally {
    scannerRefreshInFlight = false;
    $('#scanner-card').classList.remove('scanning');
    updateScanIndicator(false);
    $('#refresh-button').disabled = false;
  }
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function updateSessionClock() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const second = Number(values.second);
  const minuteOfDay = hour * 60 + minute;
  const elapsed = (minute % 15) * 60 + second;
  const remaining = 900 - elapsed;
  const minutesLeft = Math.floor(remaining / 60);
  const secondsLeft = remaining % 60;
  $('#candle-countdown').textContent = `${String(minutesLeft).padStart(2, '0')}:${String(secondsLeft).padStart(2, '0')}`;
  $('.countdown .progress').style.strokeDashoffset = String(377 * (1 - elapsed / 900));

  const isWeekday = !['Sat', 'Sun'].includes(values.weekday);
  const entriesOpen = isWeekday && minuteOfDay >= 585 && minuteOfDay < 840;
  const entriesUpcoming = isWeekday && minuteOfDay < 585;
  const managing = isWeekday && minuteOfDay >= 840 && minuteOfDay < 915;
  $('#entry-state').textContent = entriesOpen ? 'Open' : entriesUpcoming ? 'Soon' : managing ? 'Manage' : 'Closed';
  $('#market-headline').textContent = entriesOpen
    ? 'New entries are open'
    : entriesUpcoming
      ? 'New entries start at 09:45'
      : managing
        ? 'Manage open positions'
        : 'Market is closed';
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
    setConnected(true, data.profile, data.tokenRenewal);
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
  if (requestedMode === 'LIVE' && !confirm('Enable LIVE mode? Manual orders can be submitted after confirmation. If Auto trade is enabled, the server may place real orders without a per-order confirmation.')) {
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
  if (payload.enabled && currentMode === 'LIVE'
    && !confirm('Enable automatic LIVE trading? The server will place real stock-option orders when a new confirmed signal appears, without asking again for each order.')) {
    event.currentTarget.elements.autoTrade.checked = autoTradeEnabled;
    return;
  }
  try {
    const data = await api('/api/auto-trade', { method: 'POST', body: JSON.stringify(payload) });
    autoTradeEnabled = data.enabled;
    maxOpenTrades = data.settings.maxTrades;
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
  await handlePreviewClick(event);
});

$('#signal-cards').addEventListener('click', async (event) => {
  await handlePreviewClick(event);
});

async function handlePreviewClick(event) {
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
}

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
$('#scanner-filter').addEventListener('input', () => renderScanner(latestScannerResults));
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
updateSessionClock();
window.setInterval(updateSessionClock, 1000);
window.setInterval(() => {
  if (connected && $('#scan-auto-refresh').checked) refreshScanner(false).catch(() => {});
}, 1000);

try {
  $('#scan-auto-refresh').checked = localStorage.getItem('dhan-auto-scan') !== 'false';
} catch {}
updateScanIndicator();

$('#scan-auto-refresh').addEventListener('change', (event) => {
  try {
    localStorage.setItem('dhan-auto-scan', String(event.currentTarget.checked));
  } catch {}
  if (event.currentTarget.checked && connected) refreshScanner().catch(() => {});
  updateScanIndicator();
  showNotice(event.currentTarget.checked
    ? 'Auto scan enabled: scanner refreshes every second, subject to Dhan API rate limits.'
    : 'Auto scan disabled: use Refresh scanner when you want new data.', 'success');
});
