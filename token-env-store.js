'use strict';

const fs = require('node:fs');

function validateAccessToken(accessToken) {
  if (typeof accessToken !== 'string' || !/^[A-Za-z0-9._~-]{20,4096}$/.test(accessToken)) {
    throw new Error('Dhan returned an invalid access token; it was not saved.');
  }
}

function saveEnvValues(envPath, values) {
  const existingEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  let updatedEnv = existingEnv;
  for (const [key, value] of Object.entries(values)) {
    const setting = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'gm');
    if (setting.test(updatedEnv)) {
      setting.lastIndex = 0;
      updatedEnv = updatedEnv.replace(setting, (line) => `${line.slice(0, line.indexOf('=') + 1)}${value}`);
    } else {
      updatedEnv += `${updatedEnv && !updatedEnv.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
    }
  }
  const temporaryPath = `${envPath}.tmp`;
  fs.writeFileSync(temporaryPath, updatedEnv, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, envPath);
}

function saveAccessToken(envPath, accessToken) {
  validateAccessToken(accessToken);
  saveEnvValues(envPath, { DHAN_ACCESS_TOKEN: accessToken });
}

function saveDhanCredentials(envPath, clientId, accessToken) {
  const normalizedClientId = typeof clientId === 'string' ? clientId.trim() : '';
  if (!/^\d{6,12}$/.test(normalizedClientId)) {
    throw new Error('Dhan Client ID is invalid; credentials were not saved.');
  }
  validateAccessToken(accessToken);
  saveEnvValues(envPath, {
    DHAN_CLIENT_ID: normalizedClientId,
    DHAN_ACCESS_TOKEN: accessToken
  });
}

module.exports = { saveAccessToken, saveDhanCredentials };
