// Adds the commit-status webhook to every repo in a workspace.
// Dry run by default. Pass --apply to create the hooks.
//
// Env: BITBUCKET_WORKSPACE, BITBUCKET_ACCESS_TOKEN, WEBHOOK_URL (full URL including the path secret),
//      BITBUCKET_WEBHOOK_SECRET (optional, must match the server's value)
//      REPO_FILTER (optional, case-insensitive regex matched against the repo slug, e.g. "^wtg-")

const API = 'https://api.bitbucket.org/2.0';
const EVENTS = ['repo:commit_status_created', 'repo:commit_status_updated'];
const apply = process.argv.includes('--apply');

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

const workspace = required('BITBUCKET_WORKSPACE');
const token = required('BITBUCKET_ACCESS_TOKEN');
const webhookUrl = required('WEBHOOK_URL');
const secret = process.env.BITBUCKET_WEBHOOK_SECRET || undefined;
const repoFilter = process.env.REPO_FILTER ? new RegExp(process.env.REPO_FILTER, 'i') : null;

// Print the host only. The path holds the webhook secret.
const redacted = new URL(webhookUrl).origin + '/webhooks/bitbucket/<redacted>';

async function call(method, url, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get('retry-after')) || 60;
      console.log(`  rate limited, waiting ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      const detail = text.slice(0, 300).replace(/\s+/g, ' ');
      throw new Error(`${method} ${new URL(url).pathname} -> HTTP ${res.status} ${detail}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

async function listRepoSlugs() {
  const slugs = [];
  let url = `${API}/repositories/${encodeURIComponent(workspace)}?pagelen=100`;
  while (url) {
    const page = await call('GET', url);
    for (const repo of page.values ?? []) slugs.push(repo.slug);
    url = page.next;
  }
  return slugs;
}

async function existingHookUrls(slug) {
  const urls = new Set();
  let url = `${API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/hooks?pagelen=100`;
  while (url) {
    const page = await call('GET', url);
    for (const hook of page.values ?? []) urls.add(hook.url);
    url = page.next;
  }
  return urls;
}

let slugs;
try {
  slugs = await listRepoSlugs();
  if (repoFilter) slugs = slugs.filter((slug) => repoFilter.test(slug));
} catch (err) {
  console.error(`Could not list repos: ${err.message}. Check BITBUCKET_WORKSPACE and the token's Repositories: Read permission.`);
  process.exit(1);
}
console.log(`Workspace ${workspace}: ${slugs.length} repos. Webhook target ${redacted}.`);
console.log(apply ? 'Mode: APPLY' : 'Mode: DRY RUN (no changes). Pass --apply to create hooks.');

const summary = { created: 0, skipped: 0, failed: 0 };
for (const slug of slugs) {
  try {
    const existing = await existingHookUrls(slug);
    if (existing.has(webhookUrl)) {
      summary.skipped++;
      console.log(`skip   ${slug} (hook already present)`);
      continue;
    }
    if (!apply) {
      summary.created++;
      console.log(`would  ${slug}`);
      continue;
    }
    await call('POST', `${API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/hooks`, {
      description: 'deploy-status',
      url: webhookUrl,
      active: true,
      events: EVENTS,
      ...(secret ? { secret } : {}),
    });
    summary.created++;
    console.log(`added  ${slug}`);
  } catch (err) {
    summary.failed++;
    console.log(`failed ${slug}: ${err.message}`);
  }
}

console.log(`Done. ${apply ? 'created' : 'would create'}: ${summary.created}, already present: ${summary.skipped}, failed: ${summary.failed}`);
