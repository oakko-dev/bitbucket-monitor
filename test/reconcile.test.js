import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createReconciler } from '../src/reconcile.js';
import { createRecorder } from '../src/record.js';
import { openDb } from '../src/db.js';

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
    client, db: { addRepos: async () => {}, pruneRepos: async () => {}, pruneBranches: async () => {}, pruneHistory: async () => {}, listBranchStates: async () => [], getMeta: async () => null, setMeta: async () => {} }, record: async (r) => recorded.push(r.branch),
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
    client, db: { addRepos: async () => {}, pruneRepos: async () => {}, pruneBranches: async () => {}, pruneHistory: async () => {}, listBranchStates: async () => [], getMeta: async () => null, setMeta: async () => {} }, record: async () => {},
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
    client, db: { addRepos: async () => {}, pruneRepos: async () => {}, pruneBranches: async () => {}, pruneHistory: async () => {}, listBranchStates: async () => [], getMeta: async () => null, setMeta: async (k) => meta.push(k) }, record: async () => {},
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
    addRepos: async () => {}, pruneRepos: async () => {}, pruneBranches: async () => {}, pruneHistory: async () => {}, listBranchStates: async () => [],
    getMeta: async () => null,
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

test('a sync past its time budget stops, and the next run resumes after the last repo done', async () => {
  const meta = {};
  const synced = [];
  let clock = 0;
  const client = {
    listRepoSlugs: async () => ['d', 'a', 'c', 'b'],
    listBranches: async (_ws, slug) => { synced.push(slug); clock += 10; return []; },
  };
  const db = {
    addRepos: async () => {}, pruneRepos: async () => {}, pruneBranches: async () => {}, pruneHistory: async () => {}, listBranchStates: async () => [],
    getMeta: async (k) => meta[k] ?? null,
    setMeta: async (k, v) => { meta[k] = v; },
    setRepoWebhook: async () => {},
  };
  const reconcile = createReconciler({
    client, db, record: async () => {}, workspace: 'acme', webhookPathSecret: 's', recentBranchDays: 30,
    budgetMs: 15, log: { error: () => {} }, now: () => clock,
  });
  assert.equal(await reconcile(), 'partial');
  assert.deepEqual(synced, ['a', 'b']);
  assert.equal(meta.sync_cursor, 'b');
  assert.equal(await reconcile(), 'partial');
  assert.deepEqual(synced, ['a', 'b', 'c', 'd']);
  assert.equal(meta.sync_cursor, 'd');
  assert.equal(await reconcile(), 'partial');
  assert.deepEqual(synced.slice(4), ['a', 'b']);
});

test('a sync with no budget visits every repo and clears the cursor', async () => {
  const meta = { sync_cursor: 'b' };
  const synced = [];
  const client = { listRepoSlugs: async () => ['a', 'b', 'c'], listBranches: async (_ws, slug) => { synced.push(slug); return []; } };
  const db = {
    addRepos: async () => {}, pruneRepos: async () => {}, pruneBranches: async () => {}, pruneHistory: async () => {}, listBranchStates: async () => [], getMeta: async (k) => meta[k] ?? null, setMeta: async (k, v) => { meta[k] = v; }, setRepoWebhook: async () => {},
  };
  const reconcile = createReconciler({
    client, db, record: async () => {}, workspace: 'acme', webhookPathSecret: 's', recentBranchDays: 30, log: { error: () => {} },
  });
  assert.equal(await reconcile(), 'ok');
  assert.deepEqual(synced, ['c', 'a', 'b']);
  assert.equal(meta.sync_cursor, '');
});

// Runs against a real Postgres when TEST_DATABASE_URL is set. Each run uses a fresh workspace.
async function withSyncedDb(seed, client, fn) {
  const db = await openDb(process.env.TEST_DATABASE_URL);
  const workspace = `ws-${crypto.randomUUID()}`;
  try {
    await seed(db, workspace);
    const record = createRecorder({ db, notifyFailure: async () => {} });
    const reconcile = createReconciler({
      client: client(db, workspace), db, record, workspace, webhookPathSecret: 's', recentBranchDays: 30, log: { error: () => {} },
    });
    assert.equal(await reconcile(), 'ok');
    await fn((await db.listStatus(workspace)).map((r) => `${r.repo}/${r.branch}:${r.state}`).sort(), db, workspace);
  } finally {
    await db.close();
  }
}

const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const stateRow = (workspace, repo_slug, branch, latest_state, updated_at) => ({
  workspace, repo_slug, branch, latest_state, environment: 'default', pipeline_uuid: null, commit_hash: 'h', source: 'reconcile', updated_at,
});
const completed = (branch, at) => ({ target: { ref_name: branch, commit: { hash: 'h' } }, created_on: at, completed_on: at, state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } } });

test('a sync drops branches and repos that Bitbucket no longer lists', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const seed = async (db, ws) => {
    await db.addRepos(ws, ['web', 'gone']);
    await db.upsert(stateRow(ws, 'web', 'main', 'SUCCESSFUL', daysAgo(2)));
    await db.upsert(stateRow(ws, 'web', 'merged-feature', 'FAILED', daysAgo(3)));
    await db.upsert(stateRow(ws, 'gone', 'main', 'FAILED', daysAgo(3)));
  };
  const client = () => ({
    listRepoSlugs: async () => ['web'],
    listHooks: async () => [],
    listBranches: async () => [{ name: 'main', date: daysAgo(2) }],
    latestPipelineForBranch: async () => [completed('main', daysAgo(1))],
  });
  await withSyncedDb(seed, client, (rows) => assert.deepEqual(rows, ['web/main:SUCCESSFUL']));
});

test('a branch recorded after the sync read the branch list survives the prune', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const seed = (db, ws) => db.addRepos(ws, ['web']);
  const client = (db, ws) => ({
    listRepoSlugs: async () => ['web'],
    listHooks: async () => [],
    listBranches: async () => {
      await db.upsert(stateRow(ws, 'web', 'brand-new', 'INPROGRESS', new Date(Date.now() + 1000).toISOString()));
      return [{ name: 'main', date: daysAgo(1) }];
    },
    latestPipelineForBranch: async () => [completed('main', daysAgo(1))],
  });
  await withSyncedDb(seed, client, (rows) => assert.deepEqual(rows, ['web/brand-new:INPROGRESS', 'web/main:SUCCESSFUL']));
});

test('a sync re-checks a branch stuck running even when its last commit is outside the window', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const seed = async (db, ws) => {
    await db.addRepos(ws, ['web']);
    await db.upsert(stateRow(ws, 'web', 'old-release', 'INPROGRESS', daysAgo(5)));
  };
  const client = () => ({
    listRepoSlugs: async () => ['web'],
    listHooks: async () => [],
    listBranches: async () => [{ name: 'old-release', date: daysAgo(90) }],
    latestPipelineForBranch: async (_ws, _slug, branch) => [completed(branch, daysAgo(4))],
  });
  await withSyncedDb(seed, client, (rows) => assert.deepEqual(rows, ['web/old-release:SUCCESSFUL']));
});

test('an empty repo list from Bitbucket does not clear the page', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const seed = async (db, ws) => {
    await db.addRepos(ws, ['web']);
    await db.upsert(stateRow(ws, 'web', 'main', 'FAILED', daysAgo(1)));
  };
  const client = () => ({ listRepoSlugs: async () => [], listHooks: async () => [], listBranches: async () => [] });
  await withSyncedDb(seed, client, (rows) => assert.deepEqual(rows, ['web/main:FAILED']));
});

test('a sync skips a branch whose head commit is already recorded, but only when the webhook is installed', async () => {
  const recent = new Date(NOW - DAY).toISOString();
  const stored = [
    { branch: 'main', state: 'SUCCESSFUL', commit_hash: 'h1' },
    { branch: 'dev', state: 'INPROGRESS', commit_hash: 'h2' },
    { branch: 'feat', state: 'FAILED', commit_hash: 'h3' },
  ];
  const queriedWith = async (hooks) => {
    const queried = [];
    const client = {
      listRepoSlugs: async () => ['web'],
      listHooks: async () => hooks,
      listBranches: async () => [
        { name: 'main', date: recent, hash: 'h1' }, { name: 'dev', date: recent, hash: 'h2' },
        { name: 'feat', date: recent, hash: 'h4' }, { name: 'new', date: recent, hash: 'h5' },
      ],
      latestPipelineForBranch: async (_ws, _slug, branch) => { queried.push(branch); return []; },
    };
    const db = {
      addRepos: async () => {}, pruneRepos: async () => {}, pruneBranches: async () => {}, pruneHistory: async () => {},
      getMeta: async () => null, setMeta: async () => {}, setRepoWebhook: async () => {}, listBranchStates: async () => stored,
    };
    const reconcile = createReconciler({
      client, db, record: async () => {}, workspace: 'acme', webhookPathSecret: 's', recentBranchDays: 30, log: { error: () => {} }, now: () => NOW,
    });
    assert.equal(await reconcile(), 'ok');
    return queried;
  };
  assert.deepEqual(await queriedWith(['https://host.test/webhooks/bitbucket/s']), ['dev', 'feat', 'new']);
  assert.deepEqual(await queriedWith([]), ['main', 'dev', 'feat', 'new']);
});

test('a sync keeps only the newest history entries of each repo', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const entry = (ws, repo_slug, minute) => ({
    workspace: ws, repo_slug, branch: 'main', latest_state: 'SUCCESSFUL', environment: 'default', source: 'reconcile',
    updated_at: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
  });
  const seed = async (db, ws) => {
    await db.addRepos(ws, ['busy', 'quiet']);
    for (let minute = 0; minute < 205; minute++) await db.appendHistory(entry(ws, 'busy', minute));
    await db.appendHistory(entry(ws, 'quiet', 0));
  };
  const client = () => ({ listRepoSlugs: async () => ['busy', 'quiet'], listHooks: async () => [], listBranches: async () => [] });
  await withSyncedDb(seed, client, async (_rows, db, ws) => {
    const busy = await db.listHistory(ws, 'busy', 1000);
    assert.equal(busy.length, 200);
    assert.equal(busy.at(-1).updated_at, entry(ws, 'busy', 5).updated_at);
    assert.equal((await db.listHistory(ws, 'quiet', 1000)).length, 1);
  });
});
