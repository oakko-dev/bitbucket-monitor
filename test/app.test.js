import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/routes.js';

const PIPELINE_FAILED = {
  uuid: '{p1}', target: { ref_name: 'main', commit: { hash: 'abc' } }, created_on: '2026-10-10T10:00:00Z',
  state: { name: 'COMPLETED', result: { name: 'FAILED' } },
};

async function serve(overrides = {}) {
  const recorded = [];
  const outcomes = { reconcile: 'ok' };
  const app = createApp({
    db: {
      addRepos: async () => {}, setRepoWebhook: async () => {}, setMeta: async () => {}, getMeta: async () => null,
      listStatus: async () => [], listHistory: async () => [],
    },
    record: async (row) => recorded.push(row),
    bitbucket: { latestPipelineForBranch: async () => [PIPELINE_FAILED] },
    workspace: 'acme',
    reconcile: async () => outcomes.reconcile,
    cronSecret: 'cron',
    webhookSecret: null,
    webhookPathSecret: 'path',
    dashboardPassword: 'letmein',
    log: { warn: () => {}, error: () => {} },
    ...overrides,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, recorded, outcomes, close: () => new Promise((r) => server.close(r)) };
}

const basic = (password, user = 'anyone') => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const statusEvent = { repository: { full_name: 'acme/web' }, commit_status: { state: 'SUCCESSFUL', refname: 'main', key: 'some-other-ci' } };

test('the dashboard and its data routes need the login', async () => {
  const s = await serve();
  try {
    for (const path of ['/', '/api/status', '/api/history/web', '/api/meta']) {
      const anon = await fetch(s.base + path);
      assert.equal(anon.status, 401, path);
      assert.match(anon.headers.get('www-authenticate'), /^Basic/);
      assert.equal((await fetch(s.base + path, { headers: { Authorization: basic('wrong') } })).status, 401, path);
      assert.equal((await fetch(s.base + path, { headers: { Authorization: basic('letmein') } })).status, 200, path);
    }
  } finally { await s.close(); }
});

test('Sync now needs the login and the page header, and ignores the cron secret', async () => {
  const s = await serve();
  try {
    const post = (headers) => fetch(`${s.base}/api/sync`, { method: 'POST', headers });
    assert.equal((await post({ 'X-Requested-With': 'dashboard' })).status, 401);
    assert.equal((await post({ Authorization: 'Bearer cron', 'X-Requested-With': 'dashboard' })).status, 401);
    assert.equal((await post({ Authorization: basic('letmein') })).status, 403);
    const ok = await post({ Authorization: basic('letmein'), 'X-Requested-With': 'dashboard' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, outcome: 'ok' });
    s.outcomes.reconcile = 'partial';
    const partial = await post({ Authorization: basic('letmein'), 'X-Requested-With': 'dashboard' });
    assert.equal((await partial.json()).outcome, 'partial');
    s.outcomes.reconcile = 'failed';
    assert.equal((await post({ Authorization: basic('letmein'), 'X-Requested-With': 'dashboard' })).status, 502);
  } finally { await s.close(); }
});

test('the cron route takes only the cron secret, not the dashboard login', async () => {
  const s = await serve();
  try {
    assert.equal((await fetch(`${s.base}/api/reconcile`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/reconcile`, { headers: { Authorization: basic('letmein') } })).status, 401);
    assert.equal((await fetch(`${s.base}/api/reconcile`, { headers: { Authorization: 'Bearer cron' } })).status, 200);
  } finally { await s.close(); }
});

test('a webhook records the branch pipeline, not the state the commit status claims', async () => {
  const s = await serve();
  try {
    const res = await fetch(`${s.base}/webhooks/bitbucket/path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Event-Key': 'repo:commit_status_updated' },
      body: JSON.stringify(statusEvent),
    });
    assert.equal(res.status, 200);
    assert.equal(s.recorded.length, 1);
    assert.equal(s.recorded[0].latest_state, 'FAILED');
    assert.equal(s.recorded[0].source, 'webhook');
    assert.equal(s.recorded[0].branch, 'main');
  } finally { await s.close(); }
});

test('a webhook for a branch with no pipeline records nothing', async () => {
  const s = await serve({ bitbucket: { latestPipelineForBranch: async () => [] } });
  try {
    const res = await fetch(`${s.base}/webhooks/bitbucket/path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Event-Key': 'repo:commit_status_created' },
      body: JSON.stringify(statusEvent),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(s.recorded, []);
  } finally { await s.close(); }
});

test('a webhook asks Bitbucket to retry when the pipeline lookup fails', async () => {
  const s = await serve({ bitbucket: { latestPipelineForBranch: async () => { throw new Error('HTTP 500'); } } });
  try {
    const res = await fetch(`${s.base}/webhooks/bitbucket/path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Event-Key': 'repo:commit_status_updated' },
      body: JSON.stringify(statusEvent),
    });
    assert.equal(res.status, 503);
  } finally { await s.close(); }
});

test('a webhook with the wrong path secret is rejected', async () => {
  const s = await serve();
  try {
    const res = await fetch(`${s.base}/webhooks/bitbucket/nope`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
  } finally { await s.close(); }
});
