import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TEXT_CAP = 12_000;
const DIFF_CAP = 8_000;
const ROBOTS_CAP = 16_000;
const SNAPSHOTS_KEEP = 5;
const CHANGES_KEEP = 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL,
  email_verified_at TEXT,
  billing_customer_id TEXT,
  alerts_enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS email_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  selector TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'all',
  frequency TEXT NOT NULL DEFAULT 'daily',
  created_at TEXT NOT NULL,
  next_check_at TEXT NOT NULL,
  last_checked_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  prices_json TEXT NOT NULL,
  http_status INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  snapshot_id INTEGER NOT NULL,
  previous_snapshot_id INTEGER,
  summary TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  alerted_at TEXT
);
CREATE TABLE IF NOT EXISTS robots_cache (
  origin TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  status INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_daily (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monitors_due ON monitors(next_check_at);
CREATE INDEX IF NOT EXISTS idx_monitors_user ON monitors(user_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_monitor ON snapshots(monitor_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_changes_monitor ON changes(monitor_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, purpose);
CREATE INDEX IF NOT EXISTS idx_users_billing ON users(billing_customer_id);
`;

const USER_COLUMN_MIGRATIONS = [
  'ALTER TABLE users ADD COLUMN email_verified_at TEXT',
  'ALTER TABLE users ADD COLUMN billing_customer_id TEXT',
  'ALTER TABLE users ADD COLUMN alerts_enabled INTEGER NOT NULL DEFAULT 1',
];

const MONITOR_SELECT = `
SELECT monitors.*, users.email AS user_email, users.plan AS user_plan, users.alerts_enabled AS alerts_enabled
FROM monitors
JOIN users ON users.id = monitors.user_id
`;

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function trimText(value, max) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… truncated`;
}

function trimDiff(diff) {
  if (!diff) return '{}';
  const lines = Array.isArray(diff.lines) ? diff.lines.slice(0, 40) : [];
  const compact = {
    summary: trimText(diff.summary, 500),
    priceChanges: Array.isArray(diff.priceChanges) ? diff.priceChanges.slice(0, 20) : [],
    lines,
    added: diff.added || 0,
    removed: diff.removed || 0,
  };
  let json = JSON.stringify(compact);
  if (json.length > DIFF_CAP) {
    compact.lines = compact.lines.slice(0, 8);
    json = JSON.stringify(compact);
  }
  return json.slice(0, DIFF_CAP);
}

function userFromRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    passwordHash: row.password_hash,
    plan: row.plan,
    createdAt: row.created_at,
    emailVerifiedAt: row.email_verified_at || null,
    billingCustomerId: row.billing_customer_id || '',
    alertsEnabled: row.alerts_enabled == null ? true : Number(row.alerts_enabled) !== 0,
  };
}

function monitorFromRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    url: row.url,
    label: row.label,
    selector: row.selector,
    mode: row.mode,
    frequency: row.frequency,
    createdAt: row.created_at,
    nextCheckAt: row.next_check_at,
    lastCheckedAt: row.last_checked_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    contentHash: row.content_hash,
    userEmail: row.user_email,
    userPlan: row.user_plan,
    alertsEnabled: row.alerts_enabled == null ? true : Number(row.alerts_enabled) !== 0,
  };
}

function snapshotFromRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    monitorId: Number(row.monitor_id),
    checkedAt: row.checked_at,
    contentHash: row.content_hash,
    text: row.text,
    prices: parseJson(row.prices_json, []),
    httpStatus: Number(row.http_status || 0),
  };
}

function changeFromRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    monitorId: Number(row.monitor_id),
    snapshotId: Number(row.snapshot_id),
    previousSnapshotId: row.previous_snapshot_id == null ? null : Number(row.previous_snapshot_id),
    summary: row.summary,
    diff: parseJson(row.diff_json, { summary: row.summary, priceChanges: [], lines: [] }),
    createdAt: row.created_at,
    alertedAt: row.alerted_at,
    url: row.url,
    label: row.label,
    userEmail: row.user_email,
    userId: Number(row.owner_id || row.user_id),
    alertsEnabled: row.alerts_enabled == null ? true : Number(row.alerts_enabled) !== 0,
  };
}

function splitSql(sql) {
  return String(sql).split(/;\s*(?:\n|$)/).map((part) => part.trim()).filter(Boolean);
}

function sqliteDriver(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 3000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  return {
    async exec(sql) {
      for (const statement of splitSql(sql)) db.exec(statement);
    },
    async get(sql, args = []) {
      return db.prepare(sql).get(...args) ?? null;
    },
    async all(sql, args = []) {
      return db.prepare(sql).all(...args);
    },
    async run(sql, args = []) {
      const info = db.prepare(sql).run(...args);
      return { lastInsertRowid: Number(info.lastInsertRowid), changes: Number(info.changes) };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => {
          const info = db.prepare(statement.sql).run(...(statement.args || []));
          return { lastInsertRowid: Number(info.lastInsertRowid), changes: Number(info.changes) };
        });
        db.exec('COMMIT');
        return results;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* already closed */ }
        throw err;
      }
    },
    close() {
      db.close();
    },
  };
}

function plainRow(result, row) {
  if (!row) return null;
  const obj = {};
  for (const column of result.columns || []) obj[column] = row[column];
  return Object.keys(obj).length ? obj : { ...row };
}

function libsqlDriver(client) {
  return {
    async exec(sql) {
      await client.executeMultiple(sql);
    },
    async get(sql, args = []) {
      const result = await client.execute({ sql, args });
      return plainRow(result, result.rows[0]);
    },
    async all(sql, args = []) {
      const result = await client.execute({ sql, args });
      return result.rows.map((row) => plainRow(result, row));
    },
    async run(sql, args = []) {
      const result = await client.execute({ sql, args });
      return { lastInsertRowid: Number(result.lastInsertRowid || 0), changes: Number(result.rowsAffected || 0) };
    },
    async batch(statements) {
      const result = await client.batch(statements.map((statement) => ({
        sql: statement.sql,
        args: statement.args || [],
      })), 'write');
      return result.map((item) => ({
        lastInsertRowid: Number(item.lastInsertRowid || 0),
        changes: Number(item.rowsAffected || 0),
      }));
    },
    close() {
      client.close();
    },
  };
}

async function connect(options) {
  const tursoUrl = options.tursoUrl || '';
  if (tursoUrl) {
    const remote = /^(libsql|https?):/i.test(tursoUrl);
    if (remote && !options.tursoAuthToken) {
      throw new Error('TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL is a remote database.');
    }
    const { createClient } = await import('@libsql/client');
    return libsqlDriver(createClient({
      url: tursoUrl,
      authToken: options.tursoAuthToken || undefined,
    }));
  }
  return sqliteDriver(options.databasePath || ':memory:');
}

async function migrate(driver) {
  await driver.exec('PRAGMA foreign_keys = ON;');
  await driver.exec(SCHEMA);
  for (const statement of USER_COLUMN_MIGRATIONS) {
    try {
      await driver.exec(statement);
    } catch (err) {
      if (!/duplicate column|already exists/i.test(String(err.message))) throw err;
    }
  }
}

export async function openDatabase(fileOrOptions = ':memory:') {
  const options = typeof fileOrOptions === 'string' ? { databasePath: fileOrOptions } : fileOrOptions;
  const driver = await connect(options);
  await migrate(driver);
  return createRepo(driver);
}

function isUniqueError(err) {
  return /UNIQUE|PRIMARY KEY|already exists/i.test(String(err?.message || err));
}

function createRepo(driver) {
  return {
    async close() {
      driver.close();
    },
    async ping() {
      await driver.get('SELECT 1 AS ok');
    },
    async createUser({ email, passwordHash, plan = 'free', createdAt }) {
      try {
        const info = await driver.run(
          'INSERT INTO users (email, password_hash, plan, created_at) VALUES (?, ?, ?, ?)',
          [email, passwordHash, plan, createdAt],
        );
        return this.findUserById(info.lastInsertRowid);
      } catch (err) {
        if (isUniqueError(err)) return null;
        throw err;
      }
    },
    async findUserByEmail(email) {
      return userFromRow(await driver.get('SELECT * FROM users WHERE email = ?', [email]));
    },
    async findUserById(id) {
      return userFromRow(await driver.get('SELECT * FROM users WHERE id = ?', [id]));
    },
    async setPlan(userId, plan) {
      await driver.run('UPDATE users SET plan = ? WHERE id = ?', [plan, userId]);
    },
    async setPassword(userId, passwordHash) {
      await driver.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
    },
    async setBillingCustomer(userId, customerId) {
      await driver.run('UPDATE users SET billing_customer_id = ? WHERE id = ?', [customerId, userId]);
    },
    async findUserByBillingCustomer(customerId) {
      return userFromRow(await driver.get('SELECT * FROM users WHERE billing_customer_id = ?', [customerId]));
    },
    async markEmailVerified(userId, whenIso) {
      await driver.run('UPDATE users SET email_verified_at = ? WHERE id = ?', [whenIso, userId]);
    },
    async setAlertsEnabled(userId, enabled) {
      await driver.run('UPDATE users SET alerts_enabled = ? WHERE id = ?', [enabled ? 1 : 0, userId]);
    },
    async deleteUser(userId) {
      await driver.run('DELETE FROM users WHERE id = ?', [userId]);
    },
    async deleteUserSessions(userId) {
      await driver.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    },
    async createEmailToken({ userId, purpose, tokenHash, expiresAt, createdAt }) {
      await driver.batch([
        { sql: 'DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?', args: [userId, purpose] },
        {
          sql: 'INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
          args: [userId, purpose, tokenHash, expiresAt, createdAt],
        },
      ]);
    },
    async findEmailToken(tokenHash, purpose) {
      const row = await driver.get(
        'SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ?',
        [tokenHash, purpose],
      );
      if (!row) return null;
      return { id: Number(row.id), userId: Number(row.user_id), purpose: row.purpose, expiresAt: row.expires_at };
    },
    async deleteEmailTokens(userId, purpose) {
      await driver.run('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?', [userId, purpose]);
    },
    async claimBillingEvent(id, receivedAt) {
      try {
        await driver.run('INSERT INTO billing_events (id, received_at) VALUES (?, ?)', [id, receivedAt]);
        return true;
      } catch (err) {
        if (isUniqueError(err)) return false;
        throw err;
      }
    },
    async forgetBillingEvent(id) {
      await driver.run('DELETE FROM billing_events WHERE id = ?', [id]);
    },
    async createSession({ token, userId, expiresAt }) {
      await driver.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, userId, expiresAt]);
    },
    async findSession(token) {
      const row = await driver.get('SELECT * FROM sessions WHERE token = ?', [token]);
      if (!row) return null;
      return { token: row.token, userId: Number(row.user_id), expiresAt: row.expires_at };
    },
    async deleteSession(token) {
      await driver.run('DELETE FROM sessions WHERE token = ?', [token]);
    },
    async countMonitors(userId) {
      const row = await driver.get('SELECT COUNT(*) AS n FROM monitors WHERE user_id = ?', [userId]);
      return Number(row?.n || 0);
    },
    async listMonitors(userId) {
      const rows = await driver.all(`${MONITOR_SELECT} WHERE monitors.user_id = ? ORDER BY monitors.id DESC`, [userId]);
      return rows.map(monitorFromRow);
    },
    async findMonitor(id, userId) {
      return monitorFromRow(await driver.get(
        `${MONITOR_SELECT} WHERE monitors.id = ? AND monitors.user_id = ?`,
        [id, userId],
      ));
    },
    async findDuplicate(userId, url, selector, mode) {
      return await driver.get(
        'SELECT id FROM monitors WHERE user_id = ? AND url = ? AND selector = ? AND mode = ?',
        [userId, url, selector, mode],
      ) || null;
    },
    async createMonitor(row) {
      const info = await driver.run(`
        INSERT INTO monitors (user_id, url, label, selector, mode, frequency, created_at, next_check_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [row.userId, row.url, row.label, row.selector, row.mode, row.frequency, row.createdAt, row.nextCheckAt]);
      return this.findMonitor(info.lastInsertRowid, row.userId);
    },
    async deleteMonitor(id, userId) {
      const info = await driver.run('DELETE FROM monitors WHERE id = ? AND user_id = ?', [id, userId]);
      return info.changes > 0;
    },
    async listDue(nowIso, limit = 25) {
      const rows = await driver.all(
        `${MONITOR_SELECT} WHERE monitors.next_check_at <= ? ORDER BY monitors.next_check_at ASC LIMIT ?`,
        [nowIso, limit],
      );
      return rows.map(monitorFromRow);
    },
    async finishCheck(id, { status, error = '', nextCheckAt, checkedAt, contentHash }) {
      await driver.run(`
        UPDATE monitors
        SET last_status = ?, last_error = ?, next_check_at = ?, last_checked_at = ?, content_hash = COALESCE(?, content_hash)
        WHERE id = ?
      `, [status, error, nextCheckAt, checkedAt, contentHash ?? null, id]);
    },
    async setMonitorError(id, error) {
      await driver.run('UPDATE monitors SET last_error = ? WHERE id = ?', [error, id]);
    },
    async clearError(id) {
      await driver.run("UPDATE monitors SET last_error = '' WHERE id = ?", [id]);
    },
    async latestSnapshot(monitorId) {
      return snapshotFromRow(await driver.get(
        'SELECT * FROM snapshots WHERE monitor_id = ? ORDER BY id DESC LIMIT 1',
        [monitorId],
      ));
    },
    async getSnapshot(id) {
      return snapshotFromRow(await driver.get('SELECT * FROM snapshots WHERE id = ?', [id]));
    },
    async recordCheck({ monitorId, snapshot, change, finish }) {
      const statements = [{
        sql: `INSERT INTO snapshots (monitor_id, checked_at, content_hash, text, prices_json, http_status)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          monitorId,
          snapshot.checkedAt,
          snapshot.contentHash,
          trimText(snapshot.text, TEXT_CAP),
          trimText(JSON.stringify(snapshot.prices || []), 4_000),
          snapshot.httpStatus || 0,
        ],
      }];
      if (change) {
        statements.push({
          sql: `INSERT INTO changes (monitor_id, snapshot_id, previous_snapshot_id, summary, diff_json, created_at)
                VALUES (?, last_insert_rowid(), ?, ?, ?, ?)`,
          args: [
            monitorId,
            change.previousSnapshotId ?? null,
            trimText(change.summary, 500),
            trimDiff(change.diff),
            snapshot.checkedAt,
          ],
        });
      }
      statements.push({
        sql: `UPDATE monitors
              SET last_status = ?, last_error = ?, next_check_at = ?, last_checked_at = ?, content_hash = COALESCE(?, content_hash)
              WHERE id = ?`,
        args: [finish.status, finish.error || '', finish.nextCheckAt, finish.checkedAt, finish.contentHash ?? null, monitorId],
      });
      const results = await driver.batch(statements);
      await this.pruneHistory(monitorId);
      return {
        snapshotId: results[0].lastInsertRowid,
        changeId: change ? results[1].lastInsertRowid : null,
      };
    },
    async pruneHistory(monitorId) {
      await driver.run(`DELETE FROM changes WHERE monitor_id = ? AND id NOT IN (
        SELECT id FROM changes WHERE monitor_id = ? ORDER BY id DESC LIMIT ${CHANGES_KEEP}
      )`, [monitorId, monitorId]);
      await driver.run(`DELETE FROM snapshots WHERE monitor_id = ? AND id NOT IN (
        SELECT id FROM snapshots WHERE monitor_id = ? ORDER BY id DESC LIMIT ${SNAPSHOTS_KEEP}
      ) AND id NOT IN (SELECT snapshot_id FROM changes WHERE monitor_id = ?)
        AND id NOT IN (
          SELECT previous_snapshot_id FROM changes
          WHERE monitor_id = ? AND previous_snapshot_id IS NOT NULL
        )`, [monitorId, monitorId, monitorId, monitorId]);
    },
    async listChanges(monitorId, limit = 50) {
      const rows = await driver.all(
        'SELECT * FROM changes WHERE monitor_id = ? ORDER BY id DESC LIMIT ?',
        [monitorId, limit],
      );
      return rows.map(changeFromRow);
    },
    async findChange(id, userId) {
      return changeFromRow(await driver.get(`
        SELECT changes.*, monitors.url, monitors.label, users.email AS user_email,
               users.id AS owner_id, users.alerts_enabled AS alerts_enabled
        FROM changes
        JOIN monitors ON monitors.id = changes.monitor_id
        JOIN users ON users.id = monitors.user_id
        WHERE changes.id = ? AND monitors.user_id = ?
      `, [id, userId]));
    },
    async listUnalerted(limit = 20) {
      const rows = await driver.all(`
        SELECT changes.*, monitors.url, monitors.label, users.email AS user_email,
               users.id AS owner_id, users.alerts_enabled AS alerts_enabled
        FROM changes
        JOIN monitors ON monitors.id = changes.monitor_id
        JOIN users ON users.id = monitors.user_id
        WHERE changes.alerted_at IS NULL
        ORDER BY changes.id ASC
        LIMIT ?
      `, [limit]);
      return rows.map(changeFromRow);
    },
    async claimAlert(id) {
      const info = await driver.run("UPDATE changes SET alerted_at = '' WHERE id = ? AND alerted_at IS NULL", [id]);
      return info.changes === 1;
    },
    async releaseAlert(id) {
      await driver.run("UPDATE changes SET alerted_at = NULL WHERE id = ? AND alerted_at = ''", [id]);
    },
    async markAlerted(id, whenIso) {
      await driver.run("UPDATE changes SET alerted_at = ? WHERE id = ? AND alerted_at = ''", [whenIso, id]);
    },
    async getRobots(origin) {
      const row = await driver.get('SELECT * FROM robots_cache WHERE origin = ?', [origin]);
      if (!row) return null;
      return { origin: row.origin, body: row.body, fetchedAt: row.fetched_at, status: Number(row.status) };
    },
    async putRobots({ origin, body, fetchedAt, status }) {
      await driver.run(`
        INSERT INTO robots_cache (origin, body, fetched_at, status) VALUES (?, ?, ?, ?)
        ON CONFLICT(origin) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at, status = excluded.status
      `, [origin, trimText(body, ROBOTS_CAP), fetchedAt, status]);
    },
    async allowRate(key, limit, windowMs) {
      const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
      const row = await driver.get('SELECT window_start, count FROM rate_limits WHERE key = ?', [key]);
      if (!row || Number(row.window_start) !== windowStart) {
        await driver.run(`
          INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
          ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1
        `, [key, windowStart]);
        return true;
      }
      if (Number(row.count) >= limit) return false;
      await driver.run('UPDATE rate_limits SET count = count + 1 WHERE key = ?', [key]);
      return true;
    },
    async reserveMailSend(limit) {
      const day = new Date().toISOString().slice(0, 10);
      const row = await driver.get('SELECT count FROM mail_daily WHERE day = ?', [day]);
      if (row && Number(row.count) >= limit) return false;
      await driver.run(`
        INSERT INTO mail_daily (day, count) VALUES (?, 1)
        ON CONFLICT(day) DO UPDATE SET count = count + 1
      `, [day]);
      return true;
    },
  };
}
