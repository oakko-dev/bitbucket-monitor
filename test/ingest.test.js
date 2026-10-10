import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mapCommitStatus, mapPipeline, verifySignature } from '../src/ingest.js';
import { openDb } from '../src/db.js';
import { createClient } from '../src/bitbucket.js';

const payload = (state, updated_on) => ({
  repository: { full_name: 'acme/web' },
  commit_status: { state, refname: 'main', key: 'production', updated_on, commit: { hash: 'abc' } },
});

test('mapCommitStatus maps state, branch, repo, environment', () => {
  const row = mapCommitStatus(payload('FAILED', '2026-10-10T10:00:00+00:00'));
  assert.deepEqual(row, {
    workspace: 'acme', repo_slug: 'web', branch: 'main', latest_state: 'FAILED', environment: 'production',
    pipeline_uuid: null, commit_hash: 'abc', source: 'webhook', updated_at: '2026-10-10T10:00:00.000Z',
  });
  const noKey = payload('SUCCESSFUL', '2026-10-10T10:00:00Z');
  delete noKey.commit_status.key;
  assert.equal(mapCommitStatus(noKey).environment, 'default');
  assert.equal(mapCommitStatus(payload('BOGUS', '2026-10-10T10:00:00Z')), null);
});

test('mapPipeline maps completed and running pipelines', () => {
  const p = { uuid: '{u}', target: { ref_name: 'dev', commit: { hash: 'h' } }, created_on: '2026-10-10T09:00:00Z' };
  assert.equal(mapPipeline('acme', 'web', { ...p, state: { name: 'IN_PROGRESS' } }).latest_state, 'INPROGRESS');
  assert.equal(mapPipeline('acme', 'web', { ...p, state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } } }).latest_state, 'SUCCESSFUL');
});

test('upsert only replaces with a newer event, regardless of arrival order', () => {
  const db = openDb(':memory:');
  assert.equal(db.upsert(mapCommitStatus(payload('SUCCESSFUL', '2026-10-10T10:05:00Z'))), true);
  assert.equal(db.upsert(mapCommitStatus(payload('INPROGRESS', '2026-10-10T10:00:00Z'))), false);
  assert.equal(db.upsert(mapCommitStatus(payload('SUCCESSFUL', '2026-10-10T10:05:00Z'))), false);
  assert.equal(db.listStatus()[0].state, 'SUCCESSFUL');
  assert.equal(db.upsert(mapCommitStatus(payload('FAILED', '2026-10-10T10:06:00Z'))), true);
  assert.equal(db.listStatus()[0].state, 'FAILED');
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
