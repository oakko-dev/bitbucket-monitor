import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createClient } from './bitbucket.js';
import { createReconciler } from './reconcile.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const reconcile = createReconciler({
  client: createClient({ accessToken: config.accessToken }),
  db,
  workspace: config.workspace,
});

createApp({ db, webhookSecret: config.webhookSecret, webhookPathSecret: config.webhookPathSecret })
  .listen(config.port, () => console.log(`listening on :${config.port}`));

reconcile();
setInterval(reconcile, config.reconcileIntervalMs).unref();
