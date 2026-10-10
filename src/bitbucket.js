const API = 'https://api.bitbucket.org/2.0';
const MAX_429_RETRIES = 5;

export function createClient({ accessToken, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  async function getJson(url) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
      return res.json();
    }
  }

  return {
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
    async latestPipelines(workspace, slug) {
      const page = await getJson(
        `${API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/pipelines/?sort=-created_on&pagelen=1`,
      );
      return page.values ?? [];
    },
  };
}
