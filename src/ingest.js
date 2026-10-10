import crypto from 'node:crypto';

export const COMMIT_STATUS_EVENTS = new Set(['repo:commit_status_created', 'repo:commit_status_updated']);
const STATES = new Set(['SUCCESSFUL', 'FAILED', 'INPROGRESS', 'STOPPED']);

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

export function mapCommitStatus(payload) {
  const status = payload?.commit_status;
  const repo = splitFullName(payload?.repository?.full_name);
  const updated_at = toIso(status?.updated_on ?? status?.created_on);
  if (!status || !repo || !status.refname || !STATES.has(status.state) || !updated_at) return null;
  return {
    ...repo,
    branch: status.refname,
    latest_state: status.state,
    environment: status.key || status.name || 'default',
    pipeline_uuid: null,
    commit_hash: status.commit?.hash ?? null,
    source: 'webhook',
    updated_at,
  };
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
    commit_hash: pipeline.target?.commit?.hash ?? null,
    source: 'reconcile',
    updated_at,
  };
}
