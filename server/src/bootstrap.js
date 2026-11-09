import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createMailer } from './mailer.js';
import { createHostLimiter } from './net.js';

export function buildContext(env = process.env) {
  const config = loadConfig(env);
  const db = openDatabase(config.databasePath);
  const mailer = createMailer(config);
  const limiter = createHostLimiter({ minIntervalMs: config.fetchMinIntervalMs });
  return { config, db, mailer, limiter, inflight: new Set() };
}
