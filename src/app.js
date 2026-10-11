import express from 'express';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './routes.js';

// Vercel picks the entrypoint by finding a file that imports express, and expects an Express app as the default export.
// Local runs go through server.js, which calls buildApp itself.
const config = loadConfig();
const db = await openDb(config.databaseUrl);
const app = express();
app.use(buildApp(config, db));
export default app;
