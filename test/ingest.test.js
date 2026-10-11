import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mapPipeline, parseStatusEvent, verifySignature } from '../src/ingest.js';
import { openDb } from '../src/db.js';
import { createClient } from '../src/bitbucket.js';

const payload = (state, updated_on) => ({
  repository: { full_name: 'acme/web' },
  commit_status: { state, refname: 'main', key: 'production', updated_on, commit: { hash: 'abc' } },
});

test('parseStatusEvent takes only the repo and branch, whatever the status says', () => {
  assert.deepEqual(parseStatusEvent(payload('SUCCESSFUL', '2026-10-10T10:00:00Z')), { workspace: 'acme', repo_slug: 'web', branch: 'main' });
  assert.equal(parseStatusEvent({ repository: { full_name: 'acme/web' }, commit_status: {} }), null);
  assert.equal(parseStatusEvent({ commit_status: { refname: 'main' } }), null);
});

test('mapPipeline maps completed and running pipelines', () => {
  const p = { uuid: '{u}', target: { ref_name: 'dev', commit: { hash: 'h' } }, created_on: '2026-10-10T09:00:00Z' };
  assert.equal(mapPipeline('acme', 'web', { ...p, state: { name: 'IN_PROGRESS' } }).latest_state, 'INPROGRESS');
  assert.equal(mapPipeline('acme', 'web', { ...p, state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } } }).latest_state, 'SUCCESSFUL');
});

// Runs against a real Postgres when TEST_DATABASE_URL is set. Each run uses a fresh repo name.
test('upsert only replaces with a newer event, regardless of arrival order', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const db = await openDb(process.env.TEST_DATABASE_URL);
  const repo = `web-${crypto.randomUUID()}`;
  const withRepo = (state, updated_on) => {
    return {
      workspace: 'acme', repo_slug: repo, branch: 'main', latest_state: state, environment: 'prod',
      pipeline_uuid: null, commit_hash: 'abc', source: 'webhook', updated_at: new Date(updated_on).toISOString(),
    };
  };
  const stateOf = async () => (await db.listStatus('acme')).find((r) => r.repo === repo).state;
  const applied = async (r) => (await db.upsert(r)).applied;
  try {
    await db.addRepos('acme', [repo]);
    assert.equal(await applied(withRepo('SUCCESSFUL', '2026-10-10T10:05:00Z')), true);
    assert.equal(await applied(withRepo('INPROGRESS', '2026-10-10T10:00:00Z')), false);
    assert.equal(await applied(withRepo('SUCCESSFUL', '2026-10-10T10:05:00Z')), false);
    assert.equal(await stateOf(), 'SUCCESSFUL');
    assert.equal(await applied(withRepo('FAILED', '2026-10-10T10:06:00Z')), true);
    assert.equal(await stateOf(), 'FAILED');
  } finally {
    await db.close();
  }
});

test('verifySignature accepts valid HMAC and rejects tampering', () => {
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.equal(verifySignature(body, sig, 's3cret'), true);
  assert.equal(verifySignature(body, sig, 'other'), false);
  assert.equal(verifySignature(Buffer.from('{"a":2}'), sig, 's3cret'), false);
  assert.equal(verifySignature(body, 'sha256=zz', 's3cret'), false);
  assert.equal(verifySignature(body, undefined, 's3cret'), false);
});

test('client retries 429 using Retry-After, then gives up after bounded retries', async () => {
  const sleeps = [];
  let calls = 0;
  const responses = [
    new Response('', { status: 429, headers: { 'Retry-After': '2' } }),
    new Response('', { status: 429 }),
    Response.json({ values: [{ slug: 'web' }] }),
  ];
  const client = createClient({ accessToken: 't', fetchImpl: async () => responses[calls++], sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(await client.listRepoSlugs('acme'), ['web']);
  assert.deepEqual(sleeps, [2000, 60000]);

  const always429 = createClient({ accessToken: 't', fetchImpl: async () => new Response('', { status: 429 }), sleep: async () => {} });
  await assert.rejects(always429.listRepoSlugs('acme'), /HTTP 429/);
});

test('client does not sleep through a 429 wait longer than maxRetryWaitMs', async () => {
  const sleeps = [];
  const client = createClient({
    accessToken: 't', maxRetryWaitMs: 10000, sleep: async (ms) => sleeps.push(ms),
    fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }),
  });
  await assert.rejects(client.listRepoSlugs('acme'), /HTTP 429/);
  assert.deepEqual(sleeps, []);
});

// Runs against a real Postgres when TEST_DATABASE_URL is set.
test('status lists repos with no runs and meta round-trips', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const db = await openDb(process.env.TEST_DATABASE_URL);
  const workspace = `ws-${crypto.randomUUID()}`;
  try {
    await db.addRepos(workspace, ['idle-repo', 'busy-repo']);
    await db.upsert({
      workspace, repo_slug: 'busy-repo', branch: 'main', latest_state: 'FAILED', environment: 'prod',
      pipeline_uuid: null, commit_hash: 'abc', source: 'webhook', updated_at: '2026-10-10T10:00:00.000Z',
    });
    const rows = await db.listStatus(workspace);
    const idle = rows.find((r) => r.repo === 'idle-repo');
    assert.equal(idle.state, null);
    assert.equal(idle.branch, null);
    assert.equal(rows.find((r) => r.repo === 'busy-repo').state, 'FAILED');

    const key = `test-${workspace}`;
    assert.equal(await db.getMeta(key), null);
    await db.setMeta(key, '2026-10-10T10:05:00.000Z');
    await db.setMeta(key, '2026-10-10T10:10:00.000Z');
    assert.equal(await db.getMeta(key), '2026-10-10T10:10:00.000Z');
  } finally {
    await db.close();
  }
});
