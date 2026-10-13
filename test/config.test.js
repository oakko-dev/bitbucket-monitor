import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const REQUIRED = {
  DATABASE_URL: 'postgres://x', BITBUCKET_WORKSPACE: 'acme', BITBUCKET_ACCESS_TOKEN: 't', WEBHOOK_PATH_SECRET: 'p', DASHBOARD_PASSWORD: 'pw',
};

function load(env) {
  const script = "import { loadConfig } from './src/config.js'; console.log(JSON.stringify(loadConfig()));";
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, ...REQUIRED, ...env }, encoding: 'utf8',
  });
  return { status: run.status, stderr: run.stderr, config: run.status === 0 ? JSON.parse(run.stdout) : null };
}

test('a number setting that is not a number stops startup and names the variable', () => {
  for (const [name, value] of [['RECONCILE_INTERVAL_MS', 'abc'], ['RECONCILE_INTERVAL_MS', '0'], ['RECENT_BRANCH_DAYS', '-1'], ['PORT', '30OO']]) {
    const { status, stderr } = load({ [name]: value });
    assert.equal(status, 1, `${name}=${value}`);
    assert.match(stderr, new RegExp(name));
  }
});

test('an empty number setting keeps its default', () => {
  const { config } = load({ VERCEL: '1', RECONCILE_BUDGET_MS: '', RECONCILE_INTERVAL_MS: '', RECENT_BRANCH_DAYS: '' });
  assert.equal(config.reconcileBudgetMs, 40000);
  assert.equal(config.reconcileIntervalMs, 600000);
  assert.equal(config.recentBranchDays, 30);
  assert.equal(load({ RECONCILE_BUDGET_MS: '5000' }).config.reconcileBudgetMs, 5000);
});
