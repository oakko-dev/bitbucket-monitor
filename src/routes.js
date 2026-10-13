import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { COMMIT_STATUS_EVENTS, mapPipeline, parseStatusEvent, pipelineUrl, verifySignature } from './ingest.js';
import { createClient } from './bitbucket.js';
import { createLoginThrottle, createSessions, readCookie } from './session.js';
import { createReconciler } from './reconcile.js';
import { createRecorder, createSlackNotifier } from './record.js';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createApp({ db, record, bitbucket, workspace, reconcile, cronSecret, webhookSecret, webhookPathSecret, dashboardUsername, dashboardPassword, log = console, now = Date.now }) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  const sessions = createSessions({ secret: `${dashboardUsername}:${dashboardPassword}` });
  const throttle = createLoginThrottle();
  const publicDir = path.join(import.meta.dirname, 'public');
  const COOKIE = 'session';

  const cookieFlags = (req) => `Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`;
  const loggedIn = (req) => sessions.verify(readCookie(req.get('Cookie'), COOKIE));
  // Pages send people to the login form. Data routes answer 401 so the page can do the same.
  const requireLogin = (req, res, next) => {
    if (loggedIn(req)) return next();
    return req.path.startsWith('/api/') ? res.sendStatus(401) : res.redirect('/login');
  };

  // A rejected delivery is recorded, so a misconfigured webhook shows on the page instead of failing silently.
  // Anyone can post to the webhook route, so a flood of bad deliveries writes at most once a minute.
  let lastRejectWrite = -Infinity;
  const reject = async (res, status, reason) => {
    if (now() - lastRejectWrite >= 60_000) {
      lastRejectWrite = now();
      await db.setMeta('last_rejected_at', new Date().toISOString());
      await db.setMeta('last_rejected_reason', reason);
    }
    return res.sendStatus(status);
  };

  app.post('/webhooks/bitbucket/:secret', async (req, res) => {
    if (!safeEqual(req.params.secret, webhookPathSecret)) return reject(res, 403, 'path secret does not match');
    if (webhookSecret && !verifySignature(req.rawBody ?? Buffer.alloc(0), req.get('X-Hub-Signature'), webhookSecret)) {
      return reject(res, 401, 'signature does not match');
    }
    if (!COMMIT_STATUS_EVENTS.has(req.get('X-Event-Key'))) return res.sendStatus(200);
    const target = parseStatusEvent(req.body);
    if (!target) {
      log.warn('webhook: unmappable commit_status payload');
      return res.sendStatus(200);
    }
    // Rows are stored under the configured workspace, so the page finds them even when the slug's case differs.
    if (target.workspace.toLowerCase() !== workspace.toLowerCase()) return reject(res, 403, 'delivery is for another workspace');
    const { repo_slug, branch } = target;
    try {
      await db.addRepos(workspace, [repo_slug]);
      // A delivery proves the webhook is installed on this repo.
      await db.setRepoWebhook(workspace, repo_slug, true);
      for (const pipeline of await bitbucket.latestPipelineForBranch(workspace, repo_slug, branch)) {
        const row = mapPipeline(workspace, repo_slug, pipeline);
        if (row) await record({ ...row, source: 'webhook' });
      }
      await db.setMeta('last_webhook_at', new Date().toISOString());
      res.sendStatus(200);
    } catch (err) {
      log.error(`webhook upsert: ${err.message}`);
      // Non-2xx makes Bitbucket redeliver, so a database outage does not lose the event.
      res.sendStatus(503);
    }
  });

  app.get('/api/status', requireLogin, async (_req, res) => {
    try {
      res.json((await db.listStatus(workspace)).map((r) => ({ ...r, run_url: r.state ? pipelineUrl(workspace, r.repo, r.build_number) : null })));
    } catch (err) {
      log.error(`status: ${err.message}`);
      res.sendStatus(503);
    }
  });

  app.get('/api/history/:repo', requireLogin, async (req, res) => {
    try {
      res.json((await db.listHistory(workspace, req.params.repo)).map((e) => ({ ...e, run_url: pipelineUrl(workspace, req.params.repo, e.build_number) })));
    } catch (err) {
      log.error(`history: ${err.message}`);
      res.sendStatus(503);
    }
  });

  app.get('/api/meta', requireLogin, async (_req, res) => {
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

  app.use('/assets', express.static(path.join(publicDir, 'assets')));
  app.get('/', requireLogin, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  app.get('/login', (req, res) => (loggedIn(req) ? res.redirect('/') : res.sendFile(path.join(publicDir, 'login.html'))));
  // A cross-site form cannot send JSON or a custom header, so this also rejects login CSRF.
  app.post('/login', (req, res) => {
    if (req.get('X-Requested-With') !== 'dashboard' || typeof req.body?.password !== 'string') return res.sendStatus(400);
    if (throttle.blocked(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    const userOk = safeEqual(req.body.username ?? '', dashboardUsername);
    const passOk = safeEqual(req.body.password, dashboardPassword);
    if (!(userOk && passOk)) {
      throttle.fail(req.ip);
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    throttle.clear(req.ip);
    res.set('Set-Cookie', `${COOKIE}=${sessions.issue()}; Max-Age=${sessions.maxAgeSeconds}; ${cookieFlags(req)}`);
    return res.json({ ok: true });
  });
  app.post('/logout', (req, res) => {
    if (req.get('X-Requested-With') !== 'dashboard') return res.sendStatus(400);
    res.set('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags(req)}`);
    return res.json({ ok: true });
  });

  // Gated by the path secret so the workspace name is not public.
  app.get('/check/:secret', (req, res) => {
    if (!safeEqual(req.params.secret, webhookPathSecret)) return res.sendStatus(403);
    res.sendFile(path.join(publicDir, 'check.html'));
  });
  app.get('/api/check/:secret', async (req, res) => {
    if (!safeEqual(req.params.secret, webhookPathSecret)) return res.sendStatus(403);
    res.json(await bitbucket.checkWorkspace(workspace));
  });

  // Vercel Cron sends GET with "Authorization: Bearer $CRON_SECRET".
  const runSync = async (res) => {
    const outcome = await reconcile();
    if (outcome === 'failed') return res.sendStatus(502);
    res.json({ ok: true, outcome });
  };
  app.get('/api/reconcile', (req, res) => {
    if (!cronSecret || !safeEqual(req.get('Authorization') ?? '', `Bearer ${cronSecret}`)) return res.sendStatus(401);
    return runSync(res);
  });
  // The page's Sync button. Browsers attach saved Basic credentials to cross-site requests too, so a custom header
  // (which a cross-site form cannot set) keeps another site from triggering a sync.
  app.post('/api/sync', requireLogin, (req, res) => {
    if (req.get('X-Requested-With') !== 'dashboard') return res.sendStatus(403);
    return runSync(res);
  });

  return app;
}

// Wires the parts together. Shared by server.js (local) and the Vercel default export.
export function buildApp(config, db) {
  const client = createClient({
    accessToken: config.accessToken,
    maxRetryWaitMs: config.reconcileBudgetMs > 0 ? 10000 : Infinity,
  });
  // A webhook reply cannot wait out a rate limit, so it fails fast with 503 and Bitbucket or the next sync catches up.
  const webhookClient = createClient({ accessToken: config.accessToken, maxRetryWaitMs: 0 });
  const notify = createSlackNotifier({ slackWebhookUrl: config.slackWebhookUrl });
  const record = createRecorder({ db, notify });
  const reconcile = createReconciler({
    client, db, record, workspace: config.workspace, webhookPathSecret: config.webhookPathSecret, recentBranchDays: config.recentBranchDays, budgetMs: config.reconcileBudgetMs,
  });
  const app = createApp({
    db,
    record,
    bitbucket: webhookClient,
    workspace: config.workspace,
    reconcile,
    cronSecret: config.cronSecret,
    webhookSecret: config.webhookSecret,
    webhookPathSecret: config.webhookPathSecret,
    dashboardUsername: config.dashboardUsername,
    dashboardPassword: config.dashboardPassword,
  });
  app.locals.reconcile = reconcile;
  return app;
}
