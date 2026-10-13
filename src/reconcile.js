import { isOurWebhook, mapPipeline } from './ingest.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Returns 'ok' when every repo was visited, 'partial' when the time budget ended the run early (the next run resumes
// after the last repo done), 'busy' when another run is in progress, or 'failed' when the repo list could not be read.
export function createReconciler({ client, db, record, workspace, webhookPathSecret, recentBranchDays, budgetMs = 0, log = console, now = Date.now }) {
  let running = false;

  return async function reconcile() {
    if (running) return 'busy';
    running = true;
    try {
      const slugs = (await client.listRepoSlugs(workspace)).sort();
      await db.addRepos(workspace, slugs);
      // An empty list more likely means a token problem than an empty workspace, so it never clears the page.
      if (slugs.length > 0) await db.pruneRepos(workspace, slugs);
      const cursor = (await db.getMeta('sync_cursor')) ?? '';
      const next = slugs.findIndex((slug) => slug > cursor);
      const order = next === -1 ? slugs : [...slugs.slice(next), ...slugs.slice(0, next)];
      const deadline = budgetMs > 0 ? now() + budgetMs : Infinity;
      let lastDone = '';
      let complete = true;
      for (const [i, slug] of order.entries()) {
        const hooked = await checkWebhook(slug);
        try {
          await syncRepo(slug, hooked);
        } catch (err) {
          log.error(`reconcile ${slug}: ${err.message}`);
        }
        lastDone = slug;
        if (now() >= deadline && i < order.length - 1) {
          complete = false;
          break;
        }
      }
      await db.setMeta('sync_cursor', complete ? '' : lastDone);
      await db.setMeta('last_sync_at', new Date().toISOString());
      return complete ? 'ok' : 'partial';
    } catch (err) {
      log.error(`reconcile: ${err.message}`);
      return 'failed';
    } finally {
      running = false;
    }
  };

  // A failed hook lookup keeps the last known value, so a token without webhook read scope does not clear it.
  // Returns true only when the hook is known to be installed.
  async function checkWebhook(slug) {
    try {
      const urls = await client.listHooks(workspace, slug);
      const installed = urls.some((url) => isOurWebhook(url, webhookPathSecret));
      await db.setRepoWebhook(workspace, slug, installed);
      return installed;
    } catch (err) {
      log.error(`hooks ${slug}: ${err.message}`);
      return false;
    }
  }

  // Branches with no commit inside the window are skipped, so a repo with many old branches costs little.
  // A branch stored as running is always checked, because a re-run on an old branch would otherwise never finish.
  // On a repo with the webhook, a branch whose head commit is already recorded is skipped: a re-run of that commit
  // reaches the page through the webhook. Without the webhook the sync is the only source, so it checks every branch.
  async function syncRepo(slug, hooked) {
    const cutoff = now() - recentBranchDays * DAY_MS;
    const listedAt = new Date().toISOString();
    const branches = await client.listBranches(workspace, slug);
    await db.pruneBranches(workspace, slug, branches.map((b) => b.name), listedAt);
    const stored = new Map((await db.listBranchStates(workspace, slug)).map((s) => [s.branch, s]));
    for (const branch of branches) {
      const known = stored.get(branch.name);
      const running = known?.state === 'INPROGRESS';
      const recent = branch.date && Date.parse(branch.date) >= cutoff;
      if (!recent && !running) continue;
      if (hooked && known && !running && known.commit_hash === branch.hash) continue;
      for (const pipeline of await client.latestPipelineForBranch(workspace, slug, branch.name)) {
        const row = mapPipeline(workspace, slug, pipeline);
        if (row) await record(row);
      }
    }
  }
}
