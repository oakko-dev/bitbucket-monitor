# bitbucket-monitor

Deploy status dashboard for a Bitbucket Cloud workspace. Webhooks for commit statuses push updates in real time. A poller re-checks the latest pipeline of every repo every 10 minutes. Each (workspace, repo, branch) row is replaced only by an event with a newer `updated_at`, so late or duplicate deliveries do nothing.

## Setup

1. In Bitbucket, go to Workspace settings > Security > Access tokens and create a workspace access token with the **Repositories: Read** and **Pipelines: Read** scopes.
2. Copy `.env.example` to `.env` and fill it in. Put the token in your environment or secret store only, never in the repo.
   - `BITBUCKET_WORKSPACE` (required): the workspace slug
   - `BITBUCKET_ACCESS_TOKEN` (required): the token from step 1
   - `WEBHOOK_PATH_SECRET` (required): a long random string, e.g. `openssl rand -hex 24`
   - `BITBUCKET_WEBHOOK_SECRET` (optional): when set, every delivery must carry a valid `X-Hub-Signature` HMAC-SHA256
   - `PORT` (default 3000), `DB_PATH` (default `./data/status.sqlite`), `RECONCILE_INTERVAL_MS` (default 600000)
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

Open `http://localhost:3000/`. The page reloads `/api/status` every 15 seconds.

Run the tests with `npm test`.

## Docker

```sh
docker build -t bitbucket-monitor .
docker run -d -p 3000:3000 --env-file .env -v bitbucket-monitor-data:/app/data bitbucket-monitor
```

The image does not contain `.env`. Pass the variables at runtime.
