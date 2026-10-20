'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('csv-parse/sync');

const NSE_BASE = 'https://www.nseindia.com';
const BAN_CSV_URL = 'https://nsearchives.nseindia.com/content/fo/fo_secban.csv';
const MAX_DATA_AGE_MS = 15 * 60 * 1000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/csv, text/plain, */*',
  Referer: 'https://www.nseindia.com/'
};

function normalizeDate(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  const iso = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
  }
  const named = input.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s,]*(\d{4})$/);
  if (!named) return null;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = months.indexOf(named[2].toUpperCase()) + 1;
  if (!month) return null;
  const date = `${named[3]}-${String(month).padStart(2, '0')}-${named[1].padStart(2, '0')}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.records)) return payload.records;
  const holidayRows = payload?.data?.FO || payload?.FO || payload?.data?.CM || payload?.CM;
  if (Array.isArray(holidayRows)) return holidayRows;
  throw new Error('NSE returned an unrecognized market-calendar response.');
}

function parseTradingHolidays(payload) {
  const holidays = new Set();
  for (const row of extractRows(payload)) {
    const date = normalizeDate(row.tradingDate || row.date || row.holidayDate || row.trading_date);
    if (date) holidays.add(date);
  }
  if (!holidays.size) throw new Error('NSE returned no valid trading holiday dates.');
  return [...holidays].sort();
}

function parseBanCsv(csv) {
  const records = parse(csv, { skip_empty_lines: true, bom: true, relax_column_count: true });
  const headers = records[0] || [];
  const symbolIndex = headers.findIndex((header) => ['symbol', 'underlying symbol'].includes(String(header).trim().toLowerCase()));
  if (symbolIndex < 0) throw new Error('NSE F&O ban-list file has no symbol column.');
  if (records.length === 1) return [];
  const symbols = records.slice(1).map((row) => String(row[symbolIndex] || '').trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) throw new Error('NSE F&O ban-list file did not contain symbol rows.');
  return [...new Set(symbols)];
}

function responseCookies(response) {
  const headers = response.headers;
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
  return (headers.get('set-cookie') || '').match(/(?:^|,\s*)([^;,=\s]+=[^;,]*)/g)?.map((cookie) => cookie.replace(/^,\s*/, '').split(';')[0]).join('; ') || '';
}

async function fetchJson(fetchImpl, url, cookie = '') {
  const response = await fetchImpl(url, {
    headers: { ...NSE_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`NSE request failed (${response.status}).`);
  return response.json();
}

async function fetchNseRestrictions(fetchImpl) {
  const landing = await fetchImpl(`${NSE_BASE}/market-data/securities-in-ban-period`, {
    headers: NSE_HEADERS,
    signal: AbortSignal.timeout(12000)
  });
  if (!landing.ok) throw new Error(`Could not establish NSE session (${landing.status}).`);
  const cookie = responseCookies(landing);
  const [holidayPayload, banPayload] = await Promise.all([
    fetchJson(fetchImpl, `${NSE_BASE}/api/holiday-master?type=trading`, cookie),
    fetchJson(fetchImpl, `${NSE_BASE}/api/live-analysis-ban`, cookie)
      .catch(async (apiError) => {
        const response = await fetchImpl(BAN_CSV_URL, {
          headers: NSE_HEADERS,
          signal: AbortSignal.timeout(12000)
        });
        if (!response.ok) throw new Error(`NSE ban list unavailable (${apiError.message}; archive ${response.status}).`);
        return { data: parseBanCsv(await response.text()) };
      })
  ]);
  const bans = Array.isArray(banPayload.data) && banPayload.data.every((item) => typeof item === 'string')
    ? banPayload.data.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)
    : extractRows(banPayload).map((row) => String(row.symbol || row.Symbol || '').trim().toUpperCase()).filter(Boolean);
  return {
    holidays: parseTradingHolidays(holidayPayload),
    bannedSymbols: [...new Set(bans)],
    updatedAt: new Date().toISOString()
  };
}

function createMarketSafety({ statePath, fetchImpl = fetch, now = () => Date.now() }) {
  let state = null;
  let lastError = null;
  let refreshPromise = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.holidays) || !Array.isArray(parsed.bannedSymbols)
      || !parsed.holidays.every((date) => normalizeDate(date) === date)
      || !parsed.bannedSymbols.every((symbol) => typeof symbol === 'string')
      || !Number.isFinite(Date.parse(parsed.updatedAt)) || Date.parse(parsed.updatedAt) > now() + 60000) {
      throw new Error('Saved NSE market-safety data has an invalid format. Back up and inspect .dhan-market-safety.json before continuing.');
    }
    state = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error instanceof SyntaxError
      ? new Error('Saved NSE market-safety data is corrupt. Back up and inspect .dhan-market-safety.json before continuing.')
      : error;
  }

  async function refresh(force = false) {
    if (refreshPromise) return refreshPromise;
    const age = state ? now() - Date.parse(state.updatedAt) : Infinity;
    if (!force && age < REFRESH_INTERVAL_MS) return state;
    refreshPromise = fetchNseRestrictions(fetchImpl).then((next) => {
      const temporaryPath = `${statePath}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, statePath);
      state = next;
      lastError = null;
      return state;
    }).catch((error) => {
      lastError = error.message;
      throw error;
    }).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  async function assertCanTrade(symbol, date = new Date(now())) {
    try {
      await refresh();
    } catch (error) {
      const age = state ? now() - Date.parse(state.updatedAt) : Infinity;
      if (age > MAX_DATA_AGE_MS) {
        throw new Error(`Trading blocked because current NSE holiday/F&O ban data is unavailable. ${error.message}`);
      }
    }
    const age = state ? now() - Date.parse(state.updatedAt) : Infinity;
    if (!state || age > MAX_DATA_AGE_MS) {
      throw new Error('Trading blocked because current NSE holiday/F&O ban data is stale or unavailable.');
    }
    const indiaDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
    if (state.holidays.includes(indiaDate)) throw new Error(`Trading blocked: ${indiaDate} is an NSE trading holiday.`);
    if (state.bannedSymbols.includes(String(symbol).toUpperCase())) {
      throw new Error(`Trading blocked: ${symbol} is currently in the NSE F&O ban list.`);
    }
    return { updatedAt: state.updatedAt, indiaDate };
  }

  function getStatus() {
    return {
      updatedAt: state?.updatedAt || null,
      ageMs: state ? Math.max(0, now() - Date.parse(state.updatedAt)) : null,
      bannedSymbols: state?.bannedSymbols || [],
      lastError
    };
  }

  return { refresh, assertCanTrade, getStatus };
}

module.exports = {
  createMarketSafety,
  fetchNseRestrictions,
  normalizeDate,
  parseTradingHolidays,
  parseBanCsv,
  MAX_DATA_AGE_MS
};
