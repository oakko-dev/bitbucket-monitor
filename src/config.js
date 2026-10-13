function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

// A blank value counts as unset, so an empty line copied from .env.example keeps the default.
function number(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    console.error(`Env var ${name} must be a number of at least ${min}, got "${raw}"`);
    process.exit(1);
  }
  return value;
}

export function loadConfig() {
  return {
    port: number('PORT', 3000),
    databaseUrl: required('DATABASE_URL'),
    workspace: required('BITBUCKET_WORKSPACE'),
    accessToken: required('BITBUCKET_ACCESS_TOKEN'),
    webhookSecret: process.env.BITBUCKET_WEBHOOK_SECRET || null,
    webhookPathSecret: required('WEBHOOK_PATH_SECRET'),
    dashboardUsername: process.env.DASHBOARD_USERNAME || 'admin',
    dashboardPassword: required('DASHBOARD_PASSWORD'),
    cronSecret: process.env.CRON_SECRET || null,
    reconcileIntervalMs: number('RECONCILE_INTERVAL_MS', 600000, { min: 1 }),
    // Vercel kills a function after 60 s (vercel.json), so a sync stops starting new repos after this long. 0 means no limit.
    reconcileBudgetMs: number('RECONCILE_BUDGET_MS', process.env.VERCEL ? 40000 : 0),
    recentBranchDays: number('RECENT_BRANCH_DAYS', 30),
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || null,
  };
}
