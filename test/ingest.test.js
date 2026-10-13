import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
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
  assert.equal(mapPipeline('acme', 'web', { ...p, build_number: 7, state: { name: 'IN_PROGRESS' } }).build_number, 7);
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

// Runs against a real Postgres when TEST_DATABASE_URL is set. Uses its own database, because it kills connections.
test('a dropped database connection fails the call instead of crashing the process', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  const name = `drop_${crypto.randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = await openDb(url.toString());
  const holder = new pg.Client({ connectionString: url.toString() });
  await holder.connect();
  const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const kill = (onlyWaiting) => admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> $2 ${onlyWaiting ? "AND wait_event_type = 'Lock'" : ''}`,
    [name, holderPid],
  );
  const row = {
    workspace: 'acme', repo_slug: 'web', branch: 'main', latest_state: 'FAILED', environment: 'default',
    pipeline_uuid: null, commit_hash: 'abc', source: 'webhook', updated_at: '2026-10-10T10:00:00.000Z',
  };
  try {
    await db.listStatus('acme');
    await kill(false);
    await new Promise((r) => setTimeout(r, 200));

    await holder.query("SELECT pg_advisory_lock(hashtext('acme/web/main'))");
    const pending = db.upsert(row);
    for (let i = 0; i < 50 && (await kill(true)).rowCount === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(pending, /terminating connection/);
    await holder.query("SELECT pg_advisory_unlock(hashtext('acme/web/main'))");
    await new Promise((r) => setTimeout(r, 200));

    assert.equal((await db.upsert(row)).applied, true);
  } finally {
    await holder.end();
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});

// Runs against a real Postgres when TEST_DATABASE_URL is set.
test('the run number is stored with the state and the history', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const db = await openDb(process.env.TEST_DATABASE_URL);
  const workspace = `ws-${crypto.randomUUID()}`;
  const row = {
    workspace, repo_slug: 'web', branch: 'main', latest_state: 'FAILED', environment: 'default',
    pipeline_uuid: '{u}', build_number: 42, commit_hash: 'abc', source: 'webhook', updated_at: '2026-10-10T10:00:00.000Z',
  };
  try {
    await db.addRepos(workspace, ['web']);
    await db.upsert(row);
    await db.appendHistory(row);
    assert.equal((await db.listStatus(workspace))[0].build_number, 42);
    assert.equal((await db.listHistory(workspace, 'web'))[0].build_number, 42);
  } finally {
    await db.close();
  }
});
