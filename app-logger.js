'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_DAYS = 7;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function createAppLogger(logDirectory, environment = process.env, fetchImpl = fetch) {
  function write(level, message, details = {}) {
    const date = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(logDirectory, { recursive: true });
    const filePath = path.join(logDirectory, `dhan-${date}.log`);
    const currentSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    const safeMessage = String(message).replace(/[\r\n]/g, ' ');
    const safeDetails = JSON.stringify(details);
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${safeMessage}${safeDetails === '{}' ? '' : ` ${safeDetails}`}\n`;
    if (currentSize + Buffer.byteLength(line, 'utf8') > MAX_LOG_BYTES) {
      throw new Error(`Daily log reached its ${MAX_LOG_BYTES}-byte limit.`);
    }
    fs.appendFileSync(filePath, line, {
      encoding: 'utf8',
      mode: 0o600
    });
    const files = fs.readdirSync(logDirectory)
      .filter((name) => /^dhan-\d{4}-\d{2}-\d{2}\.log$/.test(name))
      .sort()
      .slice(0, -MAX_LOG_DAYS);
    for (const name of files) fs.unlinkSync(path.join(logDirectory, name));
  }

  async function telegram(message) {
    const token = environment.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = environment.TELEGRAM_CHAT_ID?.trim();
    if (!token && !chatId) return false;
    if (!token || !chatId) throw new Error('Configure both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable Telegram alerts.');
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(message).slice(0, 4000) }),
      signal: AbortSignal.timeout(10000)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) throw new Error(`Telegram notification failed (${response.status}).`);
    return true;
  }

  function alert(level, message, details = {}) {
    write(level, message, details);
    return telegram(`${level.toUpperCase()}: ${message}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`);
  }

  return { write, telegram, alert };
}

module.exports = { createAppLogger, MAX_LOG_DAYS, MAX_LOG_BYTES };
