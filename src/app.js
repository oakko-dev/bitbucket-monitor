import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { COMMIT_STATUS_EVENTS, mapCommitStatus, verifySignature } from './ingest.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createClient } from './bitbucket.js';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createApp({ db, bitbucket, workspace, webhookSecret, webhookPathSecret, log = console }) {
  const app = express();
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  app.post('/webhooks/bitbucket/:secret', (req, res) => {
    if (!safeEqual(req.params.secret, webhookPathSecret)) return res.sendStatus(403);
    if (webhookSecret && !verifySignature(req.rawBody ?? Buffer.alloc(0), req.get('X-Hub-Signature'), webhookSecret)) {
      return res.sendStatus(401);
    }
    res.sendStatus(200);
    if (!COMMIT_STATUS_EVENTS.has(req.get('X-Event-Key'))) return;
    const row = mapCommitStatus(req.body);
    if (!row) return log.warn('webhook: unmappable commit_status payload');
    try {
      db.upsert(row);
    } catch (err) {
      log.error(`webhook upsert: ${err.message}`);
    }
  });

  app.get('/api/status', (_req, res) => res.json(db.listStatus()));
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

  return app;
}

// Vercel loads this module and expects an Express app as its default export.
// Local runs go through server.js, which calls createApp itself.
const config = loadConfig();
export default createApp({
  db: openDb(config.dbPath),
  bitbucket: createClient({ accessToken: config.accessToken }),
  workspace: config.workspace,
  webhookSecret: config.webhookSecret,
  webhookPathSecret: config.webhookPathSecret,
});
