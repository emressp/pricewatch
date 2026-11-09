import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function serverRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function flag(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value === 'true' || value === 'yes';
}

export function applyDotEnv(text, env) {
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

export function loadEnvFile(root = serverRoot()) {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return;
  applyDotEnv(readFileSync(file, 'utf8'), process.env);
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const port = Number(env.PORT || 8787);
  const repoRoot = path.resolve(serverRoot(), '..');
  return {
    nodeEnv,
    port,
    databasePath: env.DATABASE_PATH || path.join(serverRoot(), 'data', 'pricewatch.sqlite'),
    sessionSecret: env.SESSION_SECRET || (nodeEnv === 'production' ? '' : 'dev-only-insecure-secret'),
    appBaseUrl: (env.APP_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    checkerEnabled: flag(env.CHECKER_ENABLED, true),
    checkIntervalSeconds: Number(env.CHECK_INTERVAL_SECONDS || 60),
    fetchMinIntervalMs: Number(env.FETCH_MIN_INTERVAL_MS || 2000),
    fetchTimeoutMs: Number(env.FETCH_TIMEOUT_MS || 15000),
    robotsTimeoutMs: Number(env.ROBOTS_TIMEOUT_MS || 8000),
    fetchMaxBytes: Number(env.FETCH_MAX_BYTES || 1_500_000),
    allowLocalFetch: flag(env.ALLOW_LOCAL_FETCH, nodeEnv !== 'production'),
    demoEnabled: flag(env.DEMO_ENABLED, nodeEnv !== 'production'),
    allowPlanSwitch: flag(env.ALLOW_PLAN_SWITCH, nodeEnv !== 'production'),
    trustProxy: flag(env.TRUST_PROXY, false),
    userAgent:
      env.USER_AGENT ||
      'PricewatchBot/1.0 (+https://emressp.github.io/pricewatch/monitor/; website change monitoring)',
    mailFrom: env.MAIL_FROM || 'Pricewatch <alerts@localhost>',
    mailOutbox: flag(env.MAIL_OUTBOX, !env.SMTP_HOST),
    logMail: flag(env.LOG_MAIL, nodeEnv !== 'production' && nodeEnv !== 'test'),
    outboxDir: env.OUTBOX_DIR || path.join(serverRoot(), 'data', 'outbox'),
    smtp: {
      host: env.SMTP_HOST || '',
      port: Number(env.SMTP_PORT || 587),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      secure: flag(env.SMTP_SECURE, false),
    },
    staticRoot: env.STATIC_ROOT || repoRoot,
  };
}
