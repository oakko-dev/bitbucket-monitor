import crypto from 'node:crypto';

export const COMMIT_STATUS_EVENTS = new Set(['repo:commit_status_created', 'repo:commit_status_updated']);

export function verifySignature(rawBody, header, secret) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function toIso(value) {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function splitFullName(fullName) {
  const [workspace, repo_slug] = String(fullName ?? '').split('/');
  return workspace && repo_slug ? { workspace, repo_slug } : null;
}

// A commit-status event only says which branch changed. The state comes from the Pipelines API, because
// statuses also come from other CI tools and from single pipeline steps.
export function parseStatusEvent(payload) {
  const repo = splitFullName(payload?.repository?.full_name);
  const branch = payload?.commit_status?.refname;
  return repo && branch ? { ...repo, branch } : null;
}

const PIPELINE_RESULT_STATES = { SUCCESSFUL: 'SUCCESSFUL', FAILED: 'FAILED', ERROR: 'FAILED', STOPPED: 'STOPPED', EXPIRED: 'STOPPED' };

function pipelineState(state) {
  if (state?.name === 'COMPLETED') return PIPELINE_RESULT_STATES[state.result?.name] ?? 'FAILED';
  return 'INPROGRESS';
}

export function mapPipeline(workspace, repo_slug, pipeline) {
  const branch = pipeline?.target?.ref_name;
  const updated_at = toIso(pipeline?.completed_on ?? pipeline?.created_on);
  if (!branch || !updated_at) return null;
  return {
    workspace,
    repo_slug,
    branch,
    latest_state: pipelineState(pipeline.state),
    environment: 'default',
    pipeline_uuid: pipeline.uuid ?? null,
    build_number: pipeline.build_number ?? null,
    commit_hash: pipeline.target?.commit?.hash ?? null,
    source: 'reconcile',
    updated_at,
  };
}

// A hook belongs to this app when its URL ends with the path secret route. Other hooks on the repo are ignored.
export function isOurWebhook(url, webhookPathSecret) {
  return typeof url === 'string' && url.endsWith(`/webhooks/bitbucket/${webhookPathSecret}`);
}
