'use strict';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isAllowedLocalHost(host) {
  if (typeof host !== 'string' || !host) return false;
  try {
    return LOCAL_HOSTS.has(new URL(`http://${host}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isSameOriginRequest(origin, requestHost) {
  if (typeof origin !== 'string' || typeof requestHost !== 'string') return false;
  try {
    return new URL(origin).host.toLowerCase() === requestHost.toLowerCase();
  } catch {
    return false;
  }
}

module.exports = { isAllowedLocalHost, isSameOriginRequest };
