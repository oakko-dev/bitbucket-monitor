const API = 'https://api.bitbucket.org/2.0';
const MAX_429_RETRIES = 5;

export function createClient({ accessToken, maxRetryWaitMs = Infinity, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  async function getJson(url) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1000;
        if (waitMs <= maxRetryWaitMs) {
          await sleep(waitMs);
          continue;
        }
      }
      if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
      return res.json();
    }
  }

  return {
    async checkWorkspace(workspace) {
      try {
        const page = await getJson(`${API}/repositories/${encodeURIComponent(workspace)}?pagelen=1`);
        return { ok: true, workspace, repos_found: page.size ?? (page.values ?? []).length };
      } catch (err) {
        return { ok: false, workspace, error: err.message };
      }
    },
    // Returns each repo hook's URL, so the sync can tell whether this app's webhook is installed.
    async listHooks(workspace, slug) {
      const urls = [];
      let url = `${API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/hooks?pagelen=100`;
      while (url) {
        const page = await getJson(url);
        for (const hook of page.values ?? []) urls.push(hook.url);
        url = page.next;
      }
      return urls;
    },
    // Returns { name, date, hash } for each branch. date is the head commit's date, used to skip long-dead branches.
    async listBranches(workspace, slug) {
      const branches = [];
      let url = `${API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/refs/branches?pagelen=100`;
      while (url) {
        const page = await getJson(url);
        for (const branch of page.values ?? []) {
          branches.push({ name: branch.name, date: branch.target?.date ?? null, hash: branch.target?.hash ?? null });
        }
        url = page.next;
      }
      return branches;
    },
    // Filters by branch name, so each branch gets its own latest pipeline.
    async latestPipelineForBranch(workspace, slug, branch) {
      const page = await getJson(
        `${API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/pipelines/` +
          `?sort=-created_on&pagelen=1&target.ref_name=${encodeURIComponent(branch)}`,
      );
      return page.values ?? [];
    },
    async listRepoSlugs(workspace) {
      const slugs = [];
      let url = `${API}/repositories/${encodeURIComponent(workspace)}?pagelen=100`;
      while (url) {
        const page = await getJson(url);
        for (const repo of page.values ?? []) slugs.push(repo.slug);
        url = page.next;
      }
      return slugs;
    },
  };
}
