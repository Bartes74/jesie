import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';
import type { PhotoCostReconciliationReport } from '@/lib/photo-cost-reconciliation-types';

const source = ts.transpileModule(readFileSync(new URL('../../app/api/admin/trends/reconcile-photo-costs/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const actor = { id: 'offline-admin', name: 'Administrator', email: 'admin@example.test' };
const report: PhotoCostReconciliationReport = {
  checkedAt: '2026-10-16T10:00:00.000Z', scannedJobs: 2, reconciledJobs: 1, pendingJobs: 1,
  alreadySettledJobs: 0, remainingJobs: 0, limited: false, estimatedCostBeforeUsd: '0.20', verifiedCostUsd: '0.04',
  before: { usedUsd: '0.30', reservedUsd: '0.10' }, after: { usedUsd: '0.24', reservedUsd: '0.10' },
  read: { status: 'verified', httpStatus: 200 },
};

function loadRoute(options: { payload?: unknown; authError?: Error; readError?: Error; serviceError?: Error; report?: PhotoCostReconciliationReport; failureStatus?: number } = {}) {
  const calls: string[] = [];
  const authCalls: [Request, boolean | undefined][] = [];
  const readCalls: Request[] = [];
  const serviceCalls: unknown[] = [];
  const errors: unknown[] = [];
  const responses: Response[] = [];
  const failure = Response.json({ error: 'Offline failure' }, { status: options.failureStatus ?? 400, headers: { 'Cache-Control': 'private, no-store' } });
  const imports: Record<string, unknown> = {
    zod: { z },
    '@/server/http/admin': {
      adminActor: async (request: Request, mutation?: boolean) => {
        calls.push('auth'); authCalls.push([request, mutation]);
        if (options.authError) throw options.authError;
        return actor;
      },
      readJson: async (request: Request) => {
        calls.push('read'); readCalls.push(request);
        if (options.readError) throw options.readError;
        return Object.hasOwn(options, 'payload') ? options.payload : { action: 'reconcile' };
      },
      adminResponse: (data: unknown) => {
        calls.push('response');
        const response = Response.json(data, { headers: { 'Cache-Control': 'private, no-store' } });
        responses.push(response);
        return response;
      },
    },
    '@/server/http/ai': { aiFailure: (error: unknown) => { calls.push('failure'); errors.push(error); return failure; } },
    '@/server/ai/photo-cost-reconciliation': {
      reconcileTrendPhotoCosts: async (value: unknown) => {
        calls.push('service'); serviceCalls.push(value);
        if (options.serviceError) throw options.serviceError;
        return options.report ?? report;
      },
    },
  };
  const exports = {} as { POST: (request: Request) => Promise<Response>; GET?: unknown; runtime: string; maxDuration: number };
  runInNewContext(source, { exports, require: (name: string) => {
    assert(Object.hasOwn(imports, name), `Unexpected route dependency: ${name}`);
    return imports[name];
  } });
  return { route: exports, calls, authCalls, readCalls, serviceCalls, errors, responses, failure };
}

const request = () => new Request('https://example.test/api/admin/trends/reconcile-photo-costs', { method: 'POST' });

test('trend photo-cost reconciliation exposes only POST on Node with a 300-second duration', () => {
  const { route } = loadRoute();
  assert.equal(typeof route.POST, 'function');
  assert.equal(Object.hasOwn(route, 'GET'), false);
  assert.equal(route.runtime, 'nodejs');
  assert.equal(route.maxDuration, 300);
});

test('trend photo-cost reconciliation authenticates a mutation and returns complete or partial reports through the no-store response helper', async () => {
  for (const value of [report, { ...report, reconciledJobs: 0, read: { status: 'forbidden' as const, httpStatus: 403 }, after: report.before }]) {
    const fixture = loadRoute({ report: value });
    const input = request();
    const response = await fixture.route.POST(input);
    assert.deepEqual(fixture.calls, ['auth', 'read', 'service', 'response']);
    assert.equal(fixture.authCalls[0][0], input);
    assert.equal(fixture.authCalls[0][1], true);
    assert.equal(fixture.readCalls[0], input);
    assert.equal(fixture.serviceCalls[0], actor);
    assert.equal(response, fixture.responses[0]);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), { report: value });
  }
});

test('trend photo-cost reconciliation refuses unauthorized requests before reading JSON or calling the service', async () => {
  const error = new Error('Offline authorization failure');
  const fixture = loadRoute({ authError: error, failureStatus: 401 });
  const response = await fixture.route.POST(request());
  assert.deepEqual(fixture.calls, ['auth', 'failure']);
  assert.deepEqual(fixture.errors, [error]);
  assert.equal(fixture.readCalls.length, 0);
  assert.equal(fixture.serviceCalls.length, 0);
  assert.equal(response, fixture.failure);
  assert.equal(response.status, 401);
});

test('trend photo-cost reconciliation accepts only the strict reconcile action payload', async () => {
  for (const payload of [undefined, null, [], {}, { action: 'refresh' }, { action: 'reconcile', dailyLimitUsd: '999' }]) {
    const fixture = loadRoute({ payload });
    const response = await fixture.route.POST(request());
    assert.deepEqual(fixture.calls, ['auth', 'read', 'failure']);
    assert.equal(fixture.serviceCalls.length, 0);
    assert(fixture.errors[0] instanceof z.ZodError);
    assert.equal(response, fixture.failure);
    assert.equal(response.status, 400);
  }
});

test('trend photo-cost reconciliation forwards invalid JSON and service failures without retrying', async () => {
  for (const stage of ['readError', 'serviceError'] as const) {
    const error = new Error(`Offline ${stage}`);
    const fixture = loadRoute({ [stage]: error });
    const response = await fixture.route.POST(request());
    assert.deepEqual(fixture.calls, stage === 'readError' ? ['auth', 'read', 'failure'] : ['auth', 'read', 'service', 'failure']);
    assert.deepEqual(fixture.errors, [error]);
    assert.equal(fixture.responses.length, 0);
    assert.equal(response, fixture.failure);
  }
});
