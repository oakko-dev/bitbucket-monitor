function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

export function loadConfig() {
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: required('DATABASE_URL'),
    workspace: required('BITBUCKET_WORKSPACE'),
    accessToken: required('BITBUCKET_ACCESS_TOKEN'),
    webhookSecret: process.env.BITBUCKET_WEBHOOK_SECRET || null,
    webhookPathSecret: required('WEBHOOK_PATH_SECRET'),
    dashboardUsername: process.env.DASHBOARD_USERNAME || 'admin',
    dashboardPassword: required('DASHBOARD_PASSWORD'),
    cronSecret: process.env.CRON_SECRET || null,
    reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS ?? 600000),
    // Vercel kills a function after 60 s (vercel.json), so a sync stops starting new repos after this long. 0 means no limit.
    reconcileBudgetMs: Number(process.env.RECONCILE_BUDGET_MS ?? (process.env.VERCEL ? 40000 : 0)),
    recentBranchDays: Number(process.env.RECENT_BRANCH_DAYS ?? 30),
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || null,
  };
}
