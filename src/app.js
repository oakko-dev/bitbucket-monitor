import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { COMMIT_STATUS_EVENTS, mapCommitStatus, verifySignature } from './ingest.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createClient } from './bitbucket.js';
import { createReconciler } from './reconcile.js';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createApp({ db, bitbucket, workspace, reconcile, cronSecret, webhookSecret, webhookPathSecret, log = console }) {
  const app = express();
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  app.post('/webhooks/bitbucket/:secret', async (req, res) => {
    if (!safeEqual(req.params.secret, webhookPathSecret)) return res.sendStatus(403);
    if (webhookSecret && !verifySignature(req.rawBody ?? Buffer.alloc(0), req.get('X-Hub-Signature'), webhookSecret)) {
      return res.sendStatus(401);
    }
    if (!COMMIT_STATUS_EVENTS.has(req.get('X-Event-Key'))) return res.sendStatus(200);
    const row = mapCommitStatus(req.body);
    if (!row) {
      log.warn('webhook: unmappable commit_status payload');
      return res.sendStatus(200);
    }
    try {
      await db.upsert(row);
      res.sendStatus(200);
    } catch (err) {
      log.error(`webhook upsert: ${err.message}`);
      // Non-2xx makes Bitbucket redeliver, so a database outage does not lose the event.
      res.sendStatus(503);
    }
  });

  app.get('/api/status', async (_req, res) => {
    try {
      res.json(await db.listStatus());
    } catch (err) {
      log.error(`status: ${err.message}`);
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

  // Vercel Cron sends "Authorization: Bearer $CRON_SECRET" when that env var is set.
  app.get('/api/reconcile', async (req, res) => {
    if (!cronSecret || !safeEqual(req.get('Authorization') ?? '', `Bearer ${cronSecret}`)) return res.sendStatus(401);
    await reconcile();
    res.json({ ok: true });
  });

  return app;
}

// Vercel loads this module and expects an Express app as its default export.
// Local runs go through server.js, which calls createApp itself.
const config = loadConfig();
const db = await openDb(config.databaseUrl);
const client = createClient({ accessToken: config.accessToken });

export default createApp({
  db,
  bitbucket: client,
  workspace: config.workspace,
  reconcile: createReconciler({ client, db, workspace: config.workspace }),
  cronSecret: config.cronSecret,
  webhookSecret: config.webhookSecret,
  webhookPathSecret: config.webhookPathSecret,
});
