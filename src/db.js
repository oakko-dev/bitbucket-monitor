import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_state (
      workspace TEXT NOT NULL,
      repo_slug TEXT NOT NULL,
      branch TEXT NOT NULL,
      latest_state TEXT NOT NULL,
      environment TEXT NOT NULL,
      pipeline_uuid TEXT,
      commit_hash TEXT,
      source TEXT NOT NULL CHECK (source IN ('webhook', 'reconcile')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace, repo_slug, branch)
    );
  `);

  // Newer-wins lives in SQL so concurrent webhook + reconcile writes stay out-of-order safe.
  // ISO-8601 UTC strings compare correctly as text only when normalized, so callers pass toISOString() output.
  const upsertStmt = db.prepare(`
    INSERT INTO pipeline_state
      (workspace, repo_slug, branch, latest_state, environment, pipeline_uuid, commit_hash, source, updated_at)
    VALUES
      (@workspace, @repo_slug, @branch, @latest_state, @environment, @pipeline_uuid, @commit_hash, @source, @updated_at)
    ON CONFLICT (workspace, repo_slug, branch) DO UPDATE SET
      latest_state = excluded.latest_state,
      environment = excluded.environment,
      pipeline_uuid = excluded.pipeline_uuid,
      commit_hash = excluded.commit_hash,
      source = excluded.source,
      updated_at = excluded.updated_at
    WHERE excluded.updated_at > pipeline_state.updated_at
  `);
  const listStmt = db.prepare(`
    SELECT repo_slug AS repo, branch, latest_state AS state, environment, updated_at, source
    FROM pipeline_state ORDER BY repo_slug, branch
  `);

  return {
    upsert: (row) => upsertStmt.run(row).changes > 0,
    listStatus: () => listStmt.all(),
    close: () => db.close(),
  };
}
