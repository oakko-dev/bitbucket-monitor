import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, createApp } from '../src/routes.js';

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
    dashboardUsername: 'ops',
    dashboardPassword: 'letmein',
    log: { warn: () => {}, error: () => {} },
    ...overrides,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, recorded, outcomes, close: () => new Promise((r) => server.close(r)) };
}

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'dashboard' };

async function signIn(base, username = 'ops', password = 'letmein') {
  const res = await fetch(`${base}/login`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username, password }) });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  return { res, cookie };
}

const statusEvent = { repository: { full_name: 'acme/web' }, commit_status: { state: 'SUCCESSFUL', refname: 'main', key: 'some-other-ci' } };

test('pages send anonymous visitors to the login form and data routes answer 401', async () => {
  const s = await serve();
  try {
    const page = await fetch(`${s.base}/`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login');
    for (const path of ['/api/status', '/api/history/web', '/api/meta']) {
      assert.equal((await fetch(s.base + path)).status, 401, path);
    }
    assert.equal((await fetch(`${s.base}/login`)).status, 200);
    assert.equal((await fetch(`${s.base}/assets/ui.css`)).status, 200);
  } finally { await s.close(); }
});

test('a correct username and password sets a session that opens the dashboard', async () => {
  const s = await serve();
  try {
    const { res, cookie } = await signIn(s.base);
    assert.equal(res.status, 200);
    const flags = res.headers.get('set-cookie');
    assert.match(flags, /HttpOnly/);
    assert.match(flags, /SameSite=Lax/);
    for (const path of ['/', '/api/status', '/api/history/web', '/api/meta']) {
      assert.equal((await fetch(s.base + path, { headers: { Cookie: cookie } })).status, 200, path);
    }
    const again = await fetch(`${s.base}/login`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(again.status, 302);
  } finally { await s.close(); }
});

test('a wrong username, a wrong password, or a forged cookie does not get in', async () => {
  const s = await serve();
  try {
    for (const [user, pass] of [['ops', 'wrong'], ['root', 'letmein'], ['', '']]) {
      const { res, cookie } = await signIn(s.base, user, pass);
      assert.equal(res.status, 401, `${user}/${pass}`);
      assert.equal(cookie, undefined);
    }
    for (const forged of ['session=9999999999.AAAA', 'session=garbage', 'session=1.x']) {
      assert.equal((await fetch(`${s.base}/api/status`, { headers: { Cookie: forged } })).status, 401, forged);
    }
    const noHeader = await fetch(`${s.base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ops', password: 'letmein' }) });
    assert.equal(noHeader.status, 400);
  } finally { await s.close(); }
});

test('repeated wrong passwords are throttled, even for the right password afterwards', async () => {
  const s = await serve();
  try {
    for (let i = 0; i < 8; i++) assert.equal((await signIn(s.base, 'ops', 'nope')).res.status, 401);
    assert.equal((await signIn(s.base, 'ops', 'nope')).res.status, 429);
    assert.equal((await signIn(s.base)).res.status, 429);
  } finally { await s.close(); }
});

test('signing out clears the session cookie', async () => {
  const s = await serve();
  try {
    const { cookie } = await signIn(s.base);
    const out = await fetch(`${s.base}/logout`, { method: 'POST', headers: { ...JSON_HEADERS, Cookie: cookie } });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  } finally { await s.close(); }
});

test('Sync now needs the session and the page header, and ignores the cron secret', async () => {
  const s = await serve();
  try {
    const { cookie } = await signIn(s.base);
    const post = (headers) => fetch(`${s.base}/api/sync`, { method: 'POST', headers });
    assert.equal((await post({ 'X-Requested-With': 'dashboard' })).status, 401);
    assert.equal((await post({ Authorization: 'Bearer cron', 'X-Requested-With': 'dashboard' })).status, 401);
    assert.equal((await post({ Cookie: cookie })).status, 403);
    const ok = await post({ Cookie: cookie, 'X-Requested-With': 'dashboard' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, outcome: 'ok' });
    s.outcomes.reconcile = 'partial';
    assert.equal((await (await post({ Cookie: cookie, 'X-Requested-With': 'dashboard' })).json()).outcome, 'partial');
    s.outcomes.reconcile = 'failed';
    assert.equal((await post({ Cookie: cookie, 'X-Requested-With': 'dashboard' })).status, 502);
  } finally { await s.close(); }
});

test('the cron route takes only the cron secret, not a dashboard session', async () => {
  const s = await serve();
  try {
    assert.equal((await fetch(`${s.base}/api/reconcile`)).status, 401);
    const { cookie } = await signIn(s.base);
    assert.equal((await fetch(`${s.base}/api/reconcile`, { headers: { Cookie: cookie } })).status, 401);
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

const postStatus = (base, body, opts = {}) => fetch(`${base}/webhooks/bitbucket/path`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Event-Key': 'repo:commit_status_updated' },
  body: JSON.stringify(body),
  ...opts,
});

test('a flood of rejected webhooks writes the rejection at most once a minute', async () => {
  const writes = [];
  let clock = 0;
  const s = await serve({
    db: { setMeta: async (key) => writes.push(key) },
    now: () => clock,
  });
  try {
    const bad = () => fetch(`${s.base}/webhooks/bitbucket/nope`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    for (let i = 0; i < 5; i++) assert.equal((await bad()).status, 403);
    assert.equal(writes.length, 2);
    clock += 60_000;
    assert.equal((await bad()).status, 403);
    assert.equal(writes.length, 4);
  } finally { await s.close(); }
});

test('a webhook from another workspace is rejected and records nothing', async () => {
  const reasons = [];
  const s = await serve({
    db: { addRepos: async () => {}, setRepoWebhook: async () => {}, setMeta: async (key, value) => { if (key === 'last_rejected_reason') reasons.push(value); } },
  });
  try {
    const res = await postStatus(s.base, { ...statusEvent, repository: { full_name: 'someone-else/web' } });
    assert.equal(res.status, 403);
    assert.deepEqual(s.recorded, []);
    assert.deepEqual(reasons, ['delivery is for another workspace']);
  } finally { await s.close(); }
});

test('a webhook whose workspace differs only in case is stored under the configured workspace', async () => {
  const added = [];
  const s = await serve({
    db: { addRepos: async (ws, slugs) => added.push(`${ws}/${slugs}`), setRepoWebhook: async () => {}, setMeta: async () => {} },
  });
  try {
    const res = await postStatus(s.base, { ...statusEvent, repository: { full_name: 'ACME/web' } });
    assert.equal(res.status, 200);
    assert.deepEqual(added, ['acme/web']);
    assert.equal(s.recorded[0].workspace, 'acme');
  } finally { await s.close(); }
});

test('a rate-limited webhook answers 503 at once instead of waiting out Retry-After', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).startsWith('https://api.bitbucket.org/')
    ? new Response('', { status: 429, headers: { 'retry-after': '2' } })
    : realFetch(url, opts));
  const db = { addRepos: async () => {}, setRepoWebhook: async () => {}, setMeta: async () => {}, getMeta: async () => null };
  const app = buildApp({
    accessToken: 't', reconcileBudgetMs: 0, workspace: 'acme', webhookPathSecret: 'path', webhookSecret: null,
    dashboardUsername: 'ops', dashboardPassword: 'pw', recentBranchDays: 30, slackWebhookUrl: null, cronSecret: null,
  }, db);
  globalThis.fetch = realFetch;
  const server = await new Promise((resolve) => { const srv = app.listen(0, () => resolve(srv)); });
  try {
    const res = await postStatus(`http://127.0.0.1:${server.address().port}`, statusEvent, { signal: AbortSignal.timeout(1000) });
    assert.equal(res.status, 503);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
