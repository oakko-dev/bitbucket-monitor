import pg from 'pg';

// CREATE TABLE IF NOT EXISTS is not safe to run concurrently on an empty database, and every cold start runs this.
// The statements share one implicit transaction, so the lock holds until the last one is done.
const SCHEMA = `
  SELECT pg_advisory_xact_lock(hashtext('bitbucket-monitor schema'));

  CREATE TABLE IF NOT EXISTS repos (
    workspace   text    NOT NULL,
    repo_slug   text    NOT NULL,
    has_webhook boolean NOT NULL DEFAULT false,
    PRIMARY KEY (workspace, repo_slug)
  );
  ALTER TABLE repos ADD COLUMN IF NOT EXISTS has_webhook boolean NOT NULL DEFAULT false;

  CREATE TABLE IF NOT EXISTS pipeline_state (
    workspace     text        NOT NULL,
    repo_slug     text        NOT NULL,
    branch        text        NOT NULL,
    latest_state  text        NOT NULL CHECK (latest_state IN ('SUCCESSFUL', 'FAILED', 'INPROGRESS', 'STOPPED')),
    environment   text        NOT NULL,
    pipeline_uuid text,
    commit_hash   text,
    source        text        NOT NULL CHECK (source IN ('webhook', 'reconcile')),
    updated_at    timestamptz NOT NULL,
    PRIMARY KEY (workspace, repo_slug, branch)
  );

  CREATE TABLE IF NOT EXISTS pipeline_history (
    id           bigserial   PRIMARY KEY,
    workspace    text        NOT NULL,
    repo_slug    text        NOT NULL,
    branch       text        NOT NULL,
    latest_state text        NOT NULL,
    environment  text        NOT NULL,
    source       text        NOT NULL,
    updated_at   timestamptz NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pipeline_history_repo
    ON pipeline_history (workspace, repo_slug, updated_at DESC);

  CREATE TABLE IF NOT EXISTS meta (
    key   text PRIMARY KEY,
    value text NOT NULL
  );
`;

// Newer-wins lives in SQL, so webhook and reconcile writes can arrive in any order.
const UPSERT_STATE = `
  INSERT INTO pipeline_state
    (workspace, repo_slug, branch, latest_state, environment, pipeline_uuid, commit_hash, source, updated_at)
  VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (workspace, repo_slug, branch) DO UPDATE SET
    latest_state = excluded.latest_state,
    environment = excluded.environment,
    pipeline_uuid = excluded.pipeline_uuid,
    commit_hash = excluded.commit_hash,
    source = excluded.source,
    updated_at = excluded.updated_at
  WHERE excluded.updated_at > pipeline_state.updated_at
`;

// Every repo appears, even one with no pipeline run yet. Those rows have null state fields.
const LIST_STATUS = `
  SELECT r.repo_slug AS repo, r.has_webhook, p.branch, p.latest_state AS state, p.environment, p.commit_hash, p.updated_at, p.source
  FROM repos r
  LEFT JOIN pipeline_state p
    ON p.workspace = r.workspace AND p.repo_slug = r.repo_slug
  WHERE r.workspace = $1
  ORDER BY r.repo_slug, p.branch NULLS FIRST
`;

const iso = (value) => (value ? new Date(value).toISOString() : null);

export async function openDb(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 3 });
  await pool.query(SCHEMA);

  return {
    // Returns whether the row was applied, and the state it replaced (null for a new branch).
    // The lock makes read-then-write atomic per branch, so two concurrent failures cannot both see the old state and both alert.
    async upsert(row) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${row.workspace}/${row.repo_slug}/${row.branch}`]);
        const before = await client.query(
          'SELECT latest_state FROM pipeline_state WHERE workspace = $1 AND repo_slug = $2 AND branch = $3',
          [row.workspace, row.repo_slug, row.branch],
        );
        const result = await client.query(UPSERT_STATE, [
          row.workspace, row.repo_slug, row.branch, row.latest_state, row.environment,
          row.pipeline_uuid, row.commit_hash, row.source, row.updated_at,
        ]);
        await client.query('COMMIT');
        return { applied: result.rowCount > 0, previous: before.rows[0]?.latest_state ?? null };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async appendHistory(row) {
      await pool.query(
        `INSERT INTO pipeline_history (workspace, repo_slug, branch, latest_state, environment, source, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.workspace, row.repo_slug, row.branch, row.latest_state, row.environment, row.source, row.updated_at],
      );
    },
    async pruneHistory(workspace, keepPerRepo) {
      await pool.query(
        `DELETE FROM pipeline_history WHERE id IN (
           SELECT id FROM (
             SELECT id, row_number() OVER (PARTITION BY repo_slug ORDER BY updated_at DESC, id DESC) AS n
             FROM pipeline_history WHERE workspace = $1
           ) ranked WHERE n > $2
         )`,
        [workspace, keepPerRepo],
      );
    },
    async listHistory(workspace, repo, limit = 20) {
      const result = await pool.query(
        `SELECT branch, latest_state AS state, environment, source, updated_at
         FROM pipeline_history
         WHERE workspace = $1 AND repo_slug = $2
         ORDER BY updated_at DESC
         LIMIT $3`,
        [workspace, repo, limit],
      );
      return result.rows.map((r) => ({ ...r, updated_at: iso(r.updated_at) }));
    },
    async addRepos(workspace, slugs) {
      if (slugs.length === 0) return;
      await pool.query(
        'INSERT INTO repos (workspace, repo_slug) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING',
        [workspace, slugs],
      );
    },
    async setRepoWebhook(workspace, slug, installed) {
      await pool.query(
        'UPDATE repos SET has_webhook = $3 WHERE workspace = $1 AND repo_slug = $2',
        [workspace, slug, installed],
      );
    },
    async listBranchStates(workspace, slug) {
      const result = await pool.query(
        'SELECT branch, latest_state AS state, commit_hash FROM pipeline_state WHERE workspace = $1 AND repo_slug = $2',
        [workspace, slug],
      );
      return result.rows;
    },
    // A row newer than listedAt may belong to a branch created after the list was read, so it stays.
    async pruneBranches(workspace, slug, liveBranches, listedAt) {
      await pool.query(
        `DELETE FROM pipeline_state
         WHERE workspace = $1 AND repo_slug = $2 AND NOT (branch = ANY($3::text[])) AND updated_at < $4`,
        [workspace, slug, liveBranches, listedAt],
      );
    },
    async pruneRepos(workspace, liveSlugs) {
      await pool.query('DELETE FROM pipeline_state WHERE workspace = $1 AND NOT (repo_slug = ANY($2::text[]))', [workspace, liveSlugs]);
      await pool.query('DELETE FROM repos WHERE workspace = $1 AND NOT (repo_slug = ANY($2::text[]))', [workspace, liveSlugs]);
    },
    async listStatus(workspace) {
      const result = await pool.query(LIST_STATUS, [workspace]);
      return result.rows.map((r) => ({ ...r, updated_at: iso(r.updated_at) }));
    },
    async setMeta(key, value) {
      await pool.query(
        'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, value],
      );
    },
    async getMeta(key) {
      const result = await pool.query('SELECT value FROM meta WHERE key = $1', [key]);
      return result.rows[0]?.value ?? null;
    },
    close: () => pool.end(),
  };
}
