import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const guard = require('./restore-egress-guard.cjs') as {
  allowedConnection: (args: unknown[], options: { httpPort: number; socketPath: string }) => boolean;
  allowedFetch: (input: unknown, port: number) => boolean;
};
const options = { httpPort: 3129, socketPath: '/private/restore/.s.PGSQL.55439' };
const run = promisify(execFile);

test('connection allowlist accepts only the exact local app port and exact restore Unix socket', () => {
  for (const args of [[3129, '127.0.0.1'], [{ port: 3129, host: 'localhost' }], [{ port: 3129, host: '::1' }], [options.socketPath], [{ path: options.socketPath }], [[{ port: 3129, host: '127.0.0.1' }, () => {}]]]) assert.equal(guard.allowedConnection(args, options), true);
  for (const args of [[443, 'api.openai.com'], [{ port: 3129, host: 'www.jesie.pl' }], [55439, '127.0.0.1'], [{ host: '127.0.0.1', port: 80 }], ['/private/other/.s.PGSQL.55439'], [{ fd: 3 }]]) assert.equal(guard.allowedConnection(args, options), false);
});

test('fetch permits only credential-free HTTP reads to the explicit loopback app port', () => {
  assert.equal(guard.allowedFetch('http://127.0.0.1:3129/pl', 3129), true);
  assert.equal(guard.allowedFetch(new Request('http://localhost:3129/media/id'), 3129), true);
  for (const url of ['https://www.jesie.pl/api/cron/seo', 'https://queue.fal.run/accepted', 'http://127.0.0.1:5432/', 'http://user:password@localhost:3129/', 'file:///private/file', '/pl']) assert.equal(guard.allowedFetch(url, 3129), false);
});

test('preload rejects provider fetch, DNS and direct sockets without making a network request', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'jesie-egress-test-')));
  try {
    const source = `const assert=require('node:assert/strict');const net=require('node:net');const dns=require('node:dns');(async()=>{await assert.rejects(fetch('https://queue.fal.run/never-sent'),{code:'RESTORE_EGRESS_BLOCKED'});assert.throws(()=>net.connect(443,'api.openai.com'),{code:'RESTORE_EGRESS_BLOCKED'});assert.throws(()=>dns.lookup('www.jesie.pl',()=>{}),{code:'RESTORE_EGRESS_BLOCKED'});await assert.rejects(dns.promises.resolve4('queue.fal.run'),{code:'RESTORE_EGRESS_BLOCKED'});assert.deepEqual(globalThis.__jesieRestoreGuard,{active:true,fetchRejected:1,socketRejected:1,dnsRejected:2});console.log('ZERO_EGRESS_GUARD_PASS')})().catch(()=>{process.exitCode=1})`;
    const result = await run(process.execPath, ['--require', resolve('scripts/restore-egress-guard.cjs'), '-e', source], { env: {
      PATH: process.env.PATH, NODE_ENV: 'test', JESIE_RESTORE_GUARD: '1', JESIE_RESTORE_HTTP_PORT: '3129', JESIE_RESTORE_SOCKET_PATH: options.socketPath,
      JESIE_RESTORE_GUARD_LOG_DIRECTORY: directory,
    }, timeout: 10_000 });
    assert.equal(result.stdout.trim(), 'ZERO_EGRESS_GUARD_PASS'); assert.equal(result.stderr, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('OS sandbox rejects a direct external TCP connection independently of the JavaScript preload', async () => {
  const profile = '(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip "localhost:*")) (allow network-outbound (remote unix-socket))';
  const source = `const socket=require('node:net').connect({host:'203.0.113.1',port:9});socket.on('connect',()=>{console.log('UNSAFE');process.exitCode=1;socket.destroy()});socket.on('error',error=>{if(error.code==='EPERM'||error.code==='EACCES')console.log('OS_SANDBOX_DENIED');else process.exitCode=1});socket.setTimeout(2000,()=>{process.exitCode=1;socket.destroy()});`;
  const result = await run('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', source], { env: { PATH: process.env.PATH, NODE_ENV: 'test' }, timeout: 10_000 });
  assert.equal(result.stdout.trim(), 'OS_SANDBOX_DENIED');
});
