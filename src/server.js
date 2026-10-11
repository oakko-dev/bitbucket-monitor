import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = await openDb(config.databaseUrl);
const app = buildApp(config, db);

app.listen(config.port, () => console.log(`listening on :${config.port}`));

app.locals.reconcile();
setInterval(app.locals.reconcile, config.reconcileIntervalMs).unref();
