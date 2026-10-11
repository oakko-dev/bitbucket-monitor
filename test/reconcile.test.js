import test from 'node:test';
import assert from 'node:assert/strict';
import { createReconciler } from '../src/reconcile.js';

const NOW = Date.parse('2026-10-20T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function fakeClient({ branches }) {
  const queried = [];
  return {
    queried,
    async listRepoSlugs() { return ['web']; },
    async listBranches() { return branches; },
    async latestPipelineForBranch(_ws, _slug, branch) {
      queried.push(branch);
      return [{ uuid: `{${branch}}`, target: { ref_name: branch, commit: { hash: 'h' } }, created_on: '2026-10-19T00:00:00Z', state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } } }];
    },
  };
}

test('sync checks only branches with a commit inside the window', async () => {
  const client = fakeClient({
    branches: [
      { name: 'main', date: new Date(NOW - 1 * DAY).toISOString() },
      { name: 'old-feature', date: new Date(NOW - 90 * DAY).toISOString() },
      { name: 'no-date', date: null },
    ],
  });
  const recorded = [];
  const reconcile = createReconciler({
    client, db: { addRepos: async () => {}, setMeta: async () => {} }, record: async (r) => recorded.push(r.branch),
    workspace: 'acme', recentBranchDays: 30, log: { error: () => {} }, now: () => NOW,
  });
  assert.equal(await reconcile(), 'ok');
  assert.deepEqual(client.queried, ['main']);
  assert.deepEqual(recorded, ['main']);
});

test('a second sync while one runs returns busy', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const client = { listRepoSlugs: async () => { await gate; return []; } };
  const reconcile = createReconciler({
    client, db: { addRepos: async () => {}, setMeta: async () => {} }, record: async () => {},
    workspace: 'acme', recentBranchDays: 30, log: { error: () => {} },
  });
  const first = reconcile();
  assert.equal(await reconcile(), 'busy');
  release();
  assert.equal(await first, 'ok');
});

test('a failed repo list returns failed and does not update last_sync_at', async () => {
  const meta = [];
  const client = { listRepoSlugs: async () => { throw new Error('HTTP 401'); } };
  const reconcile = createReconciler({
    client, db: { addRepos: async () => {}, setMeta: async (k) => meta.push(k) }, record: async () => {},
    workspace: 'acme', recentBranchDays: 30, log: { error: () => {} },
  });
  assert.equal(await reconcile(), 'failed');
  assert.deepEqual(meta, []);
});

test('sync marks a repo as wired only when this app webhook is installed', async () => {
  const flags = {};
  const client = {
    listRepoSlugs: async () => ['wired', 'other-hook', 'lookup-fails'],
    listHooks: async (_ws, slug) => {
      if (slug === 'wired') return ['https://host.test/webhooks/bitbucket/s3cret'];
      if (slug === 'other-hook') return ['https://ci.example.test/hook'];
      throw new Error('HTTP 403');
    },
    listBranches: async () => [],
  };
  const db = {
    addRepos: async () => {},
    setMeta: async () => {},
    setRepoWebhook: async (_ws, slug, installed) => { flags[slug] = installed; },
  };
  const errors = [];
  const reconcile = createReconciler({
    client, db, record: async () => {}, workspace: 'acme', webhookPathSecret: 's3cret',
    recentBranchDays: 30, log: { error: (m) => errors.push(m) },
  });
  assert.equal(await reconcile(), 'ok');
  assert.deepEqual(flags, { wired: true, 'other-hook': false });
  assert.match(errors[0], /hooks lookup-fails: HTTP 403/);
});
