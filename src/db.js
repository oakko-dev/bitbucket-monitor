import pg from 'pg';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS repos (
    workspace text NOT NULL,
    repo_slug text NOT NULL,
    PRIMARY KEY (workspace, repo_slug)
  );

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
  SELECT r.repo_slug AS repo, p.branch, p.latest_state AS state, p.environment, p.updated_at, p.source
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
    async upsert(row) {
      const before = await pool.query(
        'SELECT latest_state FROM pipeline_state WHERE workspace = $1 AND repo_slug = $2 AND branch = $3',
        [row.workspace, row.repo_slug, row.branch],
      );
      const result = await pool.query(UPSERT_STATE, [
        row.workspace, row.repo_slug, row.branch, row.latest_state, row.environment,
        row.pipeline_uuid, row.commit_hash, row.source, row.updated_at,
      ]);
      return { applied: result.rowCount > 0, previous: before.rows[0]?.latest_state ?? null };
    },
    async appendHistory(row) {
      await pool.query(
        `INSERT INTO pipeline_history (workspace, repo_slug, branch, latest_state, environment, source, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.workspace, row.repo_slug, row.branch, row.latest_state, row.environment, row.source, row.updated_at],
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
