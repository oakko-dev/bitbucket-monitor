import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './routes.js';

// Vercel finds this file by name and expects an Express app as the default export.
// Local runs go through server.js, which calls buildApp itself.
const config = loadConfig();
const db = await openDb(config.databaseUrl);
export default buildApp(config, db);
