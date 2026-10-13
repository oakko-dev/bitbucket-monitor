import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRecorder, createFailureNotifier } from '../src/record.js';
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
      return { applied: previous !== 'STALE', previous: previous === 'STALE' ? 'SUCCESSFUL' : previous };
    },
    async appendHistory(r) { log.history.push(r.latest_state); },
  };
}

test('a state change to FAILED notifies once, and a repeat FAILED does not', async () => {
  const notified = [];
  const db = fakeDb(['SUCCESSFUL', 'FAILED']);
  const record = createRecorder({ db, notifyFailure: async (r) => notified.push(r.latest_state) });
  await record(row('FAILED'));
  await record(row('FAILED'));
  assert.deepEqual(notified, ['FAILED']);
  assert.deepEqual(db.log.history, ['FAILED', 'FAILED']);
});

test('a row that loses to a newer event is not recorded or notified', async () => {
  const notified = [];
  const db = fakeDb(['STALE']);
  const record = createRecorder({ db, notifyFailure: async (r) => notified.push(r) });
  assert.equal(await record(row('FAILED')), false);
  assert.deepEqual(db.log.history, []);
  assert.deepEqual(notified, []);
});

test('a failing notifier does not stop the record', async () => {
  const errors = [];
  const db = fakeDb([null]);
  const record = createRecorder({
    db,
    notifyFailure: async () => { throw new Error('slack down'); },
    log: { error: (m) => errors.push(m) },
  });
  assert.equal(await record(row('FAILED')), true);
  assert.deepEqual(db.log.history, ['FAILED']);
  assert.match(errors[0], /slack down/);
});

test('the Slack notifier does nothing without a URL', async () => {
  let called = false;
  const notify = createFailureNotifier({ slackWebhookUrl: null, fetchImpl: async () => { called = true; } });
  await notify(row('FAILED'));
  assert.equal(called, false);
});

test('a failed branch first seen by the sync is backfilled without notifying', async () => {
  const notified = [];
  const db = fakeDb([null]);
  const record = createRecorder({ db, notifyFailure: async (r) => notified.push(r) });
  assert.equal(await record(row('FAILED', { source: 'reconcile' })), true);
  assert.deepEqual(db.log.history, ['FAILED']);
  assert.deepEqual(notified, []);
});

test('a sync that finds a known branch newly FAILED still notifies', async () => {
  const notified = [];
  const db = fakeDb(['SUCCESSFUL']);
  const record = createRecorder({ db, notifyFailure: async (r) => notified.push(r) });
  await record(row('FAILED', { source: 'reconcile' }));
  assert.equal(notified.length, 1);
});

test('a new branch whose first event is a webhook FAILED still notifies', async () => {
  const notified = [];
  const db = fakeDb([null]);
  const record = createRecorder({ db, notifyFailure: async (r) => notified.push(r) });
  await record(row('FAILED'));
  assert.equal(notified.length, 1);
});

// Runs against a real Postgres when TEST_DATABASE_URL is set. Each run uses a fresh workspace.
test('two failures for one branch recorded at the same moment notify once', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const db = await openDb(process.env.TEST_DATABASE_URL);
  const workspace = `ws-${crypto.randomUUID()}`;
  const notified = [];
  const record = createRecorder({ db, notifyFailure: async (r) => notified.push(r.branch) });
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
