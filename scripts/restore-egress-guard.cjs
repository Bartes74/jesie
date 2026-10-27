'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preloads must run before application ESM evaluation. */

const net = require('node:net');
const dns = require('node:dns');
const fs = require('node:fs');
const path = require('node:path');
const { threadId } = require('node:worker_threads');

function loopback(host) { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase()); }
function allowedConnection(args, options) {
  let value = args[0];
  if (Array.isArray(value)) return allowedConnection(value, options);
  if (typeof value === 'number') value = { port: value, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  else if (typeof value === 'string') value = { path: value };
  if (!value || typeof value !== 'object') return false;
  if (value.port !== undefined) return loopback(value.host ?? value.hostname ?? 'localhost') && Number(value.port) === options.httpPort;
  return typeof value.path === 'string' && value.path === options.socketPath;
}
function allowedFetch(input, httpPort) {
  try {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    return url.protocol === 'http:' && !url.username && !url.password && loopback(url.hostname) && Number(url.port) === httpPort;
  } catch { return false; }
}
module.exports = { loopback, allowedConnection, allowedFetch };

if (process.env.JESIE_RESTORE_GUARD === '1') {
  const httpPort = Number(process.env.JESIE_RESTORE_HTTP_PORT);
  const socketPath = process.env.JESIE_RESTORE_SOCKET_PATH;
  const logDirectory = process.env.JESIE_RESTORE_GUARD_LOG_DIRECTORY;
  if (!Number.isInteger(httpPort) || httpPort < 1024 || httpPort > 65535 || !socketPath || !path.isAbsolute(socketPath)
    || !logDirectory || !path.isAbsolute(logDirectory)) throw new Error('RESTORE_GUARD_CONFIGURATION_INVALID');
  const state = { active: true, fetchRejected: 0, socketRejected: 0, dnsRejected: 0 };
  globalThis.__jesieRestoreGuard = state;
  const blocked = kind => { state[kind]++; const error = new Error('RESTORE_EGRESS_BLOCKED'); error.code = 'RESTORE_EGRESS_BLOCKED'; return error; };
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    if (!allowedConnection(args, { httpPort, socketPath })) throw blocked('socketRejected');
    return originalConnect.apply(this, args);
  };
  const originalLookup = dns.lookup;
  dns.lookup = function (host, ...args) {
    if (!loopback(host)) throw blocked('dnsRejected');
    return originalLookup.call(this, host, ...args);
  };
  const promiseLookup = dns.promises.lookup;
  dns.promises.lookup = async function (host, ...args) {
    if (!loopback(host)) throw blocked('dnsRejected');
    return promiseLookup.call(this, host, ...args);
  };
  for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
    dns[name] = function () { throw blocked('dnsRejected'); };
    dns.promises[name] = async function () { throw blocked('dnsRejected'); };
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input, ...args) {
    if (!allowedFetch(input, httpPort)) throw blocked('fetchRejected');
    return originalFetch.call(this, input, ...args);
  };
  process.on('exit', () => {
    try { fs.writeFileSync(path.join(logDirectory, `guard-${process.pid}-${threadId}.private.json`), JSON.stringify(state), { flag: 'wx', mode: 0o600 }); }
    catch { /* Never log a pathname, request, secret or response body. */ }
  });
}
