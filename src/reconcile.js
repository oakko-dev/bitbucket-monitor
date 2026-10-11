import { mapPipeline } from './ingest.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Returns 'ok', 'busy' when another run is in progress, or 'failed' when the repo list could not be read.
export function createReconciler({ client, db, record, workspace, recentBranchDays, log = console, now = Date.now }) {
  let running = false;

  return async function reconcile() {
    if (running) return 'busy';
    running = true;
    try {
      const slugs = await client.listRepoSlugs(workspace);
      await db.addRepos(workspace, slugs);
      for (const slug of slugs) {
        try {
          await syncRepo(slug);
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

  // Branches with no commit inside the window are skipped, so a repo with many old branches costs little.
  async function syncRepo(slug) {
    const cutoff = now() - recentBranchDays * DAY_MS;
    const branches = await client.listBranches(workspace, slug);
    for (const branch of branches) {
      if (!branch.date || Date.parse(branch.date) < cutoff) continue;
      for (const pipeline of await client.latestPipelineForBranch(workspace, slug, branch.name)) {
        const row = mapPipeline(workspace, slug, pipeline);
        if (row) await record(row);
      }
    }
  }
}
