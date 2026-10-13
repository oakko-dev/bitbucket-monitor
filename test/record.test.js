import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRecorder, createSlackNotifier } from '../src/record.js';
import { openDb } from '../src/db.js';

const row = (state, extra = {}) => ({
  workspace: 'acme', repo_slug: 'web', branch: 'main', latest_state: state, environment: 'prod',
  source: 'webhook', updated_at: '2026-10-10T10:00:00.000Z', ...extra,
});

function fakeDb(previousStates) {
  const log = { history: [], upserts: [] };
  let i = 0;
  return {
    log,
    async upsert(r) {
      log.upserts.push(r.latest_state);
      const previous = previousStates[i++] ?? null;
      const shown = previous === 'STALE' ? 'SUCCESSFUL' : previous;
      return { applied: previous !== 'STALE', previous: shown, previousResult: ['SUCCESSFUL', 'FAILED'].includes(shown) ? shown : null };
    },
    async appendHistory(r) { log.history.push(r.latest_state); },
  };
}

test('a state change to FAILED notifies once, and a repeat FAILED does not', async () => {
  const notified = [];
  const db = fakeDb(['SUCCESSFUL', 'FAILED']);
  const record = createRecorder({ db, notify: async (kind) => notified.push(kind) });
  await record(row('FAILED'));
  await record(row('FAILED'));
  assert.deepEqual(notified, ['failed']);
  assert.deepEqual(db.log.history, ['FAILED', 'FAILED']);
});

test('a row that loses to a newer event is not recorded or notified', async () => {
  const notified = [];
  const db = fakeDb(['STALE']);
  const record = createRecorder({ db, notify: async (kind) => notified.push(kind) });
  assert.equal(await record(row('FAILED')), false);
  assert.deepEqual(db.log.history, []);
  assert.deepEqual(notified, []);
});

test('a failing notifier does not stop the record', async () => {
  const errors = [];
  const db = fakeDb([null]);
  const record = createRecorder({
    db,
    notify: async () => { throw new Error('slack down'); },
    log: { error: (m) => errors.push(m) },
  });
  assert.equal(await record(row('FAILED')), true);
  assert.deepEqual(db.log.history, ['FAILED']);
  assert.match(errors[0], /slack down/);
});

test('the Slack notifier does nothing without a URL', async () => {
  let called = false;
  const notify = createSlackNotifier({ slackWebhookUrl: null, fetchImpl: async () => { called = true; } });
  await notify('failed', row('FAILED'));
  assert.equal(called, false);
});

test('a failed branch first seen by the sync is backfilled without notifying', async () => {
  const notified = [];
  const db = fakeDb([null]);
  const record = createRecorder({ db, notify: async (kind) => notified.push(kind) });
  assert.equal(await record(row('FAILED', { source: 'reconcile' })), true);
  assert.deepEqual(db.log.history, ['FAILED']);
  assert.deepEqual(notified, []);
});

test('a sync that finds a known branch newly FAILED still notifies', async () => {
  const notified = [];
  const db = fakeDb(['SUCCESSFUL']);
  const record = createRecorder({ db, notify: async (kind) => notified.push(kind) });
  await record(row('FAILED', { source: 'reconcile' }));
  assert.equal(notified.length, 1);
});

test('a new branch whose first event is a webhook FAILED still notifies', async () => {
  const notified = [];
  const db = fakeDb([null]);
  const record = createRecorder({ db, notify: async (kind) => notified.push(kind) });
  await record(row('FAILED'));
  assert.equal(notified.length, 1);
});

// Runs against a real Postgres when TEST_DATABASE_URL is set. Each run uses a fresh workspace.
test('two failures for one branch recorded at the same moment notify once', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const db = await openDb(process.env.TEST_DATABASE_URL);
  const workspace = `ws-${crypto.randomUUID()}`;
  const notified = [];
  const record = createRecorder({ db, notify: async (_kind, r) => notified.push(r.branch) });
  const branches = Array.from({ length: 20 }, (_, i) => `b${i}`);
  try {
    for (const branch of branches) await record(row('INPROGRESS', { workspace, branch, updated_at: '2026-10-10T10:00:00.000Z' }));
    await Promise.all(branches.flatMap((branch) => [
      record(row('FAILED', { workspace, branch, updated_at: '2026-10-10T10:05:00.000Z' })),
      record(row('FAILED', { workspace, branch, updated_at: '2026-10-10T10:06:00.000Z' })),
    ]));
    assert.deepEqual(notified.sort(), branches.sort());
  } finally {
    await db.close();
  }
});

test('a Slack alert links to the pipeline run and escapes the branch name', async () => {
  const posts = [];
  const notify = createSlackNotifier({
    slackWebhookUrl: 'https://hooks.slack.test/x',
    fetchImpl: async (_url, opts) => { posts.push(JSON.parse(opts.body).text); return new Response('ok'); },
  });
  const failed = row('FAILED', { branch: 'fix/<a&b>', build_number: 42 });
  await notify('failed', failed);
  await notify('fixed', { ...failed, latest_state: 'SUCCESSFUL', build_number: 43 });
  assert.match(posts[0], /failed/i);
  assert.ok(posts[0].includes('<https://bitbucket.org/acme/web/pipelines/results/42|#42>'), posts[0]);
  assert.ok(posts[0].includes('fix/&lt;a&amp;b&gt;'), posts[0]);
  assert.match(posts[1], /fixed/i);
  assert.ok(posts[1].includes('<https://bitbucket.org/acme/web/pipelines/results/43|#43>'), posts[1]);
});

// Runs against a real Postgres when TEST_DATABASE_URL is set. Each run uses a fresh workspace.
test('alerts follow the last finished result, so re-runs in between do not hide a fix or repeat a failure', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const db = await openDb(process.env.TEST_DATABASE_URL);
  const workspace = `ws-${crypto.randomUUID()}`;
  const alerts = [];
  const record = createRecorder({ db, notify: async (kind) => alerts.push(kind) });
  const states = ['SUCCESSFUL', 'INPROGRESS', 'FAILED', 'INPROGRESS', 'FAILED', 'STOPPED', 'INPROGRESS', 'SUCCESSFUL', 'INPROGRESS', 'SUCCESSFUL'];
  try {
    for (const [minute, state] of states.entries()) {
      await record(row(state, { workspace, updated_at: new Date(Date.UTC(2026, 9, 10, 10, minute)).toISOString() }));
    }
    assert.deepEqual(alerts, ['failed', 'fixed']);
  } finally {
    await db.close();
  }
});
