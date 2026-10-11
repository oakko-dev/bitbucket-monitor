import { mapPipeline } from './ingest.js';

// Returns 'ok', 'busy' when another run is in progress, or 'failed' when the repo list could not be read.
export function createReconciler({ client, db, workspace, log = console }) {
  let running = false;

  return async function reconcile() {
    if (running) return 'busy';
    running = true;
    try {
      const slugs = await client.listRepoSlugs(workspace);
      await db.addRepos(workspace, slugs);
      for (const slug of slugs) {
        try {
          for (const pipeline of await client.latestPipelines(workspace, slug)) {
            const row = mapPipeline(workspace, slug, pipeline);
            if (row) await db.upsert(row);
          }
        } catch (err) {
          log.error(`reconcile ${slug}: ${err.message}`);
        }
      }
      await db.setMeta('last_sync_at', new Date().toISOString());
      return 'ok';
    } catch (err) {
      log.error(`reconcile: ${err.message}`);
      return 'failed';
    } finally {
      running = false;
    }
  };
}
