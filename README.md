# bitbucket-monitor

Deploy status dashboard for a Bitbucket Cloud workspace. A commit-status webhook tells the app a branch changed, and the app reads that branch's latest pipeline from Bitbucket, so statuses from other CI tools cannot overwrite the pipeline state. A poller re-checks the latest pipeline of every repo every 10 minutes. Each (workspace, repo, branch) row is replaced only by an event with a newer `updated_at`, so late or duplicate deliveries do nothing.

## Setup

1. In Bitbucket, go to Workspace settings > Security > Access tokens and create a workspace access token with the **Repositories: Read** and **Pipelines: Read** scopes.
2. Copy `.env.example` to `.env` and fill it in. Put the token in your environment or secret store only, never in the repo.
   - `BITBUCKET_WORKSPACE` (required): the workspace slug
   - `BITBUCKET_ACCESS_TOKEN` (required): the token from step 1
   - `WEBHOOK_PATH_SECRET` (required): a long random string, e.g. `openssl rand -hex 24`
   - `BITBUCKET_WEBHOOK_SECRET` (optional): when set, every delivery must carry a valid `X-Hub-Signature` HMAC-SHA256
   - `DATABASE_URL` (required): a Postgres connection string
   - `DASHBOARD_USERNAME` (default `admin`) and `DASHBOARD_PASSWORD` (required): the dashboard login. Generate the password with `openssl rand -hex 24`. Changing either signs everyone out
   - `CRON_SECRET` (Vercel only): Vercel Cron sends it to `/api/reconcile`. The Sync button does not use it
   - `RECONCILE_BUDGET_MS` (default 40000 on Vercel, no limit elsewhere): a sync stops starting new repos after this long and resumes after the last repo done on the next run
   - `PORT` (default 3000), `RECONCILE_INTERVAL_MS` (default 600000, from 1000 to 2147483647)
   - A number setting left blank keeps its default. One that is not a number, or is out of range, stops startup with an error naming it
3. For each repo, add a webhook under Repository settings > Webhooks:
   - URL: `https://<host>/webhooks/bitbucket/<WEBHOOK_PATH_SECRET>`
   - Triggers: Commit status created, Commit status updated
   - Secret: the same value as `BITBUCKET_WEBHOOK_SECRET`, if you set one

## Run

```sh
npm install
set -a; . ./.env; set +a
npm start
```

Open `http://localhost:3000/` and sign in with `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD`. The page reloads `/api/status` every 15 seconds.

Run the tests with `npm test`. The database tests run only when `TEST_DATABASE_URL` points at a Postgres you can write to, for example:

```sh
docker run -d --rm --name bbm-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npm test
```

GitHub Actions runs the full suite against Postgres on every push and pull request.

## Docker

```sh
docker build -t bitbucket-monitor .
docker run -d -p 3000:3000 --env-file .env bitbucket-monitor
```

The image does not contain `.env`. Pass the variables at runtime. Data lives in `DATABASE_URL`, so the container keeps no state.

## Vercel

Vercel functions cannot keep local files, so the data lives in Postgres.

1. In Vercel, add the **Neon** (Postgres) integration from the Marketplace. It sets `DATABASE_URL`.
2. Add `BITBUCKET_WORKSPACE`, `BITBUCKET_ACCESS_TOKEN`, `WEBHOOK_PATH_SECRET`, `DASHBOARD_PASSWORD`, and `CRON_SECRET` in the project's environment variables.
3. Deploy. `vercel.json` schedules `/api/reconcile` once a day at 00:00 UTC.

Hobby allows one cron run per day, which is why the schedule is daily. On Pro, change the schedule to `*/10 * * * *` to sync every 10 minutes. Webhooks update the page in real time either way.

A sync that runs out of its time budget finishes the remaining repos on the next run, whether that is the next cron tick or the next click on Sync now. On Hobby, a workspace with many repos can take several days to sweep once.

## Add the webhook to every repo

`scripts/add-webhooks.mjs` creates the commit-status webhook on each repo in the workspace. It skips repos that already have the URL. It runs as a dry run unless you pass `--apply`.

```bash
BITBUCKET_WORKSPACE=<workspace> \
BITBUCKET_ACCESS_TOKEN=<token> \
WEBHOOK_URL=https://<your-host>/webhooks/bitbucket/<WEBHOOK_PATH_SECRET> \
node scripts/add-webhooks.mjs
```

Check the dry-run output, then add `--apply` to the same command.

To limit the run to some repos, set `REPO_FILTER` to a case-insensitive regex matched against the repo slug. For example, `REPO_FILTER='^wtg-'` covers only repos starting with `wtg-`.

## Sync and status

The page lists every repo in the workspace. A repo with no pipeline run shows "No runs yet". The header shows when the last webhook arrived and when the last sync finished.

**Sync now** runs the same sync as the cron. It uses your dashboard sign-in, not `CRON_SECRET`. If Bitbucket cannot return the repo list, the sync returns 502 and the page says it failed.

## Alerts, history, and branches

- **Branches.** Each sync checks every branch that had a commit in the last `RECENT_BRANCH_DAYS` (default 30). Older branches are skipped to keep the sync within the time limit, except a branch the page shows as running, which is checked until it finishes.
- **Deleted branches and repos.** A sync removes a branch from the page once Bitbucket no longer lists it, and removes a repo once it leaves the workspace. An empty repo list is treated as an error and removes nothing. Their history stays in the database.
- **Alerts.** Set `SLACK_WEBHOOK_URL` to a Slack incoming webhook. A message posts when a branch changes to FAILED from another state. A repeat FAILED does not post again.
- **History.** Click a repo name on the page to see its last 20 recorded state changes. Only changes that were applied are recorded.
- **Rejected webhooks.** A delivery with a wrong path, a wrong signature, or a repo from another workspace returns 403 or 401. The page shows a recent rejection and its reason, so a misconfigured webhook is visible. Each server instance records at most one rejection a minute.

## Repo filter

By default the page lists only repos that have this app's webhook installed or have run a pipeline. Tick **Show all repos** to list every repo. The count next to the checkbox shows how many repos are in view.

Each sync reads every repo's hook list to find this app's webhook. The token needs webhook read permission for this check. Without it, the sync logs a `hooks <repo>` error for each repo and keeps the last known value.
