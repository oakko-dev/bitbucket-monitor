import pg from 'pg';

const SCHEMA = `
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
`;

// Newer-wins lives in SQL, so webhook and reconcile writes can arrive in any order.
const UPSERT = `
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

const LIST = `
  SELECT repo_slug AS repo, branch, latest_state AS state, environment, updated_at, source
  FROM pipeline_state
  ORDER BY repo_slug, branch
`;

export async function openDb(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 3 });
  await pool.query(SCHEMA);

  return {
    async upsert(row) {
      const result = await pool.query(UPSERT, [
        row.workspace, row.repo_slug, row.branch, row.latest_state, row.environment,
        row.pipeline_uuid, row.commit_hash, row.source, row.updated_at,
      ]);
      return result.rowCount > 0;
    },
    async listStatus() {
      const result = await pool.query(LIST);
      return result.rows.map((r) => ({ ...r, updated_at: new Date(r.updated_at).toISOString() }));
    },
    close: () => pool.end(),
  };
}
