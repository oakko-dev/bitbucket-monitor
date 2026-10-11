import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { COMMIT_STATUS_EVENTS, mapCommitStatus, verifySignature } from './ingest.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createClient } from './bitbucket.js';
import { createReconciler } from './reconcile.js';
import { createFailureNotifier, createRecorder } from './record.js';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createApp({ db, record, bitbucket, workspace, reconcile, cronSecret, webhookSecret, webhookPathSecret, log = console }) {
  const app = express();
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  // A rejected delivery is recorded, so a misconfigured webhook shows on the page instead of failing silently.
  const reject = async (res, status, reason) => {
    await db.setMeta('last_rejected_at', new Date().toISOString());
    await db.setMeta('last_rejected_reason', reason);
    return res.sendStatus(status);
  };

  app.post('/webhooks/bitbucket/:secret', async (req, res) => {
    if (!safeEqual(req.params.secret, webhookPathSecret)) return reject(res, 403, 'path secret does not match');
    if (webhookSecret && !verifySignature(req.rawBody ?? Buffer.alloc(0), req.get('X-Hub-Signature'), webhookSecret)) {
      return reject(res, 401, 'signature does not match');
    }
    if (!COMMIT_STATUS_EVENTS.has(req.get('X-Event-Key'))) return res.sendStatus(200);
    const row = mapCommitStatus(req.body);
    if (!row) {
      log.warn('webhook: unmappable commit_status payload');
      return res.sendStatus(200);
    }
    try {
      await db.addRepos(row.workspace, [row.repo_slug]);
      // A delivery proves the webhook is installed on this repo.
      await db.setRepoWebhook(row.workspace, row.repo_slug, true);
      await record(row);
      await db.setMeta('last_webhook_at', new Date().toISOString());
      res.sendStatus(200);
    } catch (err) {
      log.error(`webhook upsert: ${err.message}`);
      // Non-2xx makes Bitbucket redeliver, so a database outage does not lose the event.
      res.sendStatus(503);
    }
  });

  app.get('/api/status', async (_req, res) => {
    try {
      res.json(await db.listStatus(workspace));
    } catch (err) {
      log.error(`status: ${err.message}`);
      res.sendStatus(503);
    }
  });

  app.get('/api/history/:repo', async (req, res) => {
    try {
      res.json(await db.listHistory(workspace, req.params.repo));
    } catch (err) {
      log.error(`history: ${err.message}`);
      res.sendStatus(503);
    }
  });

  app.get('/api/meta', async (_req, res) => {
    try {
      res.json({
        last_webhook_at: await db.getMeta('last_webhook_at'),
        last_sync_at: await db.getMeta('last_sync_at'),
        last_rejected_at: await db.getMeta('last_rejected_at'),
        last_rejected_reason: await db.getMeta('last_rejected_reason'),
      });
    } catch (err) {
      log.error(`meta: ${err.message}`);
      res.sendStatus(503);
    }
  });

  app.get('/', (_req, res) => res.sendFile(path.join(import.meta.dirname, 'public', 'index.html')));

  // Gated by the path secret so the workspace name is not public.
  app.get('/check/:secret', (req, res) => {
    if (!safeEqual(req.params.secret, webhookPathSecret)) return res.sendStatus(403);
    res.sendFile(path.join(import.meta.dirname, 'public', 'check.html'));
  });
  app.get('/api/check/:secret', async (req, res) => {
    if (!safeEqual(req.params.secret, webhookPathSecret)) return res.sendStatus(403);
    res.json(await bitbucket.checkWorkspace(workspace));
  });

  // Vercel Cron sends GET with "Authorization: Bearer $CRON_SECRET". The page's Sync button sends POST with the same header.
  const sync = async (req, res) => {
    if (!cronSecret || !safeEqual(req.get('Authorization') ?? '', `Bearer ${cronSecret}`)) return res.sendStatus(401);
    const outcome = await reconcile();
    if (outcome === 'failed') return res.sendStatus(502);
    res.json({ ok: true, started: outcome === 'ok' });
  };
  app.get('/api/reconcile', sync);
  app.post('/api/sync', sync);

  return app;
}

// Wires the parts together. Shared by server.js (local) and the Vercel default export.
export function buildApp(config, db) {
  const client = createClient({ accessToken: config.accessToken });
  const notifyFailure = createFailureNotifier({ slackWebhookUrl: config.slackWebhookUrl });
  const record = createRecorder({ db, notifyFailure });
  const reconcile = createReconciler({
    client, db, record, workspace: config.workspace, webhookPathSecret: config.webhookPathSecret, recentBranchDays: config.recentBranchDays,
  });
  const app = createApp({
    db,
    record,
    bitbucket: client,
    workspace: config.workspace,
    reconcile,
    cronSecret: config.cronSecret,
    webhookSecret: config.webhookSecret,
    webhookPathSecret: config.webhookPathSecret,
  });
  app.locals.reconcile = reconcile;
  return app;
}

// Vercel loads this module and expects an Express app as its default export.
// Local runs go through server.js, which calls buildApp itself.
const config = loadConfig();
const db = await openDb(config.databaseUrl);
export default buildApp(config, db);
