'use strict';

const fs = require('node:fs');

function saveAccessToken(envPath, accessToken) {
  if (typeof accessToken !== 'string' || !/^[A-Za-z0-9._~-]{20,4096}$/.test(accessToken)) {
    throw new Error('Dhan returned an invalid access token; it was not saved.');
  }

  const existingEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const tokenSetting = /^[ \t]*DHAN_ACCESS_TOKEN[ \t]*=.*$/m;
  const updatedEnv = tokenSetting.test(existingEnv)
    ? existingEnv.replace(tokenSetting, (line) => `${line.slice(0, line.indexOf('=') + 1)}${accessToken}`)
    : `${existingEnv}${existingEnv && !existingEnv.endsWith('\n') ? '\n' : ''}DHAN_ACCESS_TOKEN=${accessToken}\n`;
  const temporaryPath = `${envPath}.tmp`;
  fs.writeFileSync(temporaryPath, updatedEnv, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, envPath);
}

module.exports = { saveAccessToken };
