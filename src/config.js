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
    dbPath: process.env.DB_PATH ?? './data/status.sqlite',
    workspace: required('BITBUCKET_WORKSPACE'),
    accessToken: required('BITBUCKET_ACCESS_TOKEN'),
    webhookSecret: process.env.BITBUCKET_WEBHOOK_SECRET || null,
    webhookPathSecret: required('WEBHOOK_PATH_SECRET'),
    reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS ?? 600000),
  };
}
