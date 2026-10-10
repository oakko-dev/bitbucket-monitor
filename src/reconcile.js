import { mapPipeline } from './ingest.js';

export function createReconciler({ client, db, workspace, log = console }) {
  let running = false;

  return async function reconcile() {
    if (running) return;
    running = true;
    try {
      const slugs = await client.listRepoSlugs(workspace);
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
    } catch (err) {
      log.error(`reconcile: ${err.message}`);
    } finally {
      running = false;
    }
  };
}
