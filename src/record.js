import { pipelineUrl } from './ingest.js';

// Every state change goes through here, from webhooks and from the sync alike.
// A row that loses to a newer one is ignored, so history and alerts only see real changes.
export function createRecorder({ db, notify, log = console }) {
  return async function record(row) {
    const { applied, previous, previousResult } = await db.upsert(row);
    if (!applied) return false;
    await db.appendHistory(row);
    const kind = alertFor(row, previous, previousResult);
    if (kind) {
      try {
        await notify(kind, row);
      } catch (err) {
        log.error(`notify ${row.repo_slug}: ${err.message}`);
      }
    }
    return true;
  };
}

// Alerts compare finished results, so a re-run in between neither repeats a failure nor hides a fix.
function alertFor(row, previous, previousResult) {
  // A branch the sync sees for the first time is backfill, not a new failure, so it must not page anyone.
  if (previous === null && row.source === 'reconcile') return null;
  if (row.latest_state === 'FAILED' && previousResult !== 'FAILED') return 'failed';
  if (row.latest_state === 'SUCCESSFUL' && previousResult === 'FAILED') return 'fixed';
  return null;
}

const slackEscape = (text) => String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const MESSAGES = {
  failed: (repo, branch, run) => `:red_circle: Pipeline failed: ${repo} on ${branch} (${run})`,
  fixed: (repo, branch, run) => `:large_green_circle: Fixed: ${repo} on ${branch} passed again (${run})`,
};

// Posts to a Slack incoming webhook when set. Without a URL, alerts are only shown on the page.
export function createSlackNotifier({ slackWebhookUrl, fetchImpl = fetch }) {
  return async function notify(kind, row) {
    if (!slackWebhookUrl) return;
    const url = pipelineUrl(row.workspace, row.repo_slug, row.build_number);
    const run = `<${url}|${row.build_number == null ? 'pipelines' : `#${row.build_number}`}>`;
    const text = MESSAGES[kind](slackEscape(`${row.workspace}/${row.repo_slug}`), slackEscape(row.branch), run);
    const res = await fetchImpl(slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Slack returned HTTP ${res.status}`);
  };
}
