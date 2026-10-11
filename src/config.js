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
    cronSecret: process.env.CRON_SECRET || null,
    reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS ?? 600000),
    recentBranchDays: Number(process.env.RECENT_BRANCH_DAYS ?? 30),
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || null,
  };
}
