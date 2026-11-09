import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createMailer } from './mailer.js';
import { createHostLimiter } from './net.js';
import { createBillingProvider } from './billing.js';
import { createRateLimiter } from './rate-limit.js';

export function buildContext(env = process.env) {
  const config = loadConfig(env);
  const db = openDatabase(config.databasePath);
  const mailer = createMailer(config);
  const limiter = createHostLimiter({ minIntervalMs: config.fetchMinIntervalMs });
  return {
    config,
    db,
    mailer,
    limiter,
    inflight: new Set(),
    authLimiter: createRateLimiter({ limit: config.authRateLimit, windowMs: config.authRateWindowMs }),
    urlLimiter: createRateLimiter({ limit: config.urlRateLimit, windowMs: config.urlRateWindowMs }),
    billing: createBillingProvider(config),
  };
}
