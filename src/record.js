// Every state change goes through here, from webhooks and from the sync alike.
// A row that loses to a newer one is ignored, so history and alerts only see real changes.
export function createRecorder({ db, notifyFailure, log = console }) {
  return async function record(row) {
    const { applied, previous } = await db.upsert(row);
    if (!applied) return false;
    await db.appendHistory(row);
    if (row.latest_state === 'FAILED' && previous !== 'FAILED') {
      try {
        await notifyFailure(row);
      } catch (err) {
        log.error(`notify ${row.repo_slug}: ${err.message}`);
      }
    }
    return true;
  };
}

// Posts to a Slack incoming webhook when set. Without a URL, failures are only shown on the page.
export function createFailureNotifier({ slackWebhookUrl, fetchImpl = fetch }) {
  return async function notifyFailure(row) {
    if (!slackWebhookUrl) return;
    const text = `Pipeline FAILED: ${row.workspace}/${row.repo_slug} on ${row.branch} (${row.environment})`;
    const res = await fetchImpl(slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Slack returned HTTP ${res.status}`);
  };
}
