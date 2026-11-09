import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
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
    id: row.id,
    userId: row.user_id,
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
    id: row.id,
    monitorId: row.monitor_id,
    checkedAt: row.checked_at,
    contentHash: row.content_hash,
    text: row.text,
    prices: parseJson(row.prices_json, []),
    httpStatus: row.http_status,
  };
}

function changeFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    monitorId: row.monitor_id,
    snapshotId: row.snapshot_id,
    previousSnapshotId: row.previous_snapshot_id,
    summary: row.summary,
    diff: parseJson(row.diff_json, { summary: row.summary, priceChanges: [], lines: [] }),
    createdAt: row.created_at,
    alertedAt: row.alerted_at,
    url: row.url,
    label: row.label,
    userEmail: row.user_email,
    userId: row.owner_id || row.user_id,
    alertsEnabled: row.alerts_enabled == null ? true : Number(row.alerts_enabled) !== 0,
  };
}

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec('PRAGMA busy_timeout = 3000;');
  if (file !== ':memory:') sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec(SCHEMA);
  for (const statement of USER_COLUMN_MIGRATIONS) {
    try { sqlite.exec(statement); } catch (err) {
      if (!/duplicate column/i.test(String(err.message))) throw err;
    }
  }
  return createRepo(sqlite);
}

function createRepo(sqlite) {
  function transaction(fn) {
    sqlite.exec('BEGIN');
    try {
      const result = fn();
      sqlite.exec('COMMIT');
      return result;
    } catch (err) {
      try { sqlite.exec('ROLLBACK'); } catch { /* already closed */ }
      throw err;
    }
  }

  return {
    sqlite,
    close() {
      sqlite.close();
    },
    ping() {
      sqlite.prepare('SELECT 1 AS ok').get();
    },
    createUser({ email, passwordHash, plan = 'free', createdAt }) {
      try {
        const info = sqlite.prepare(
          'INSERT INTO users (email, password_hash, plan, created_at) VALUES (?, ?, ?, ?)',
        ).run(email, passwordHash, plan, createdAt);
        return this.findUserById(Number(info.lastInsertRowid));
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) return null;
        throw err;
      }
    },
    findUserByEmail(email) {
      return userFromRow(sqlite.prepare('SELECT * FROM users WHERE email = ?').get(email));
    },
    findUserById(id) {
      return userFromRow(sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id));
    },
    setPlan(userId, plan) {
      sqlite.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, userId);
    },
    setBillingCustomer(userId, customerId) {
      sqlite.prepare('UPDATE users SET billing_customer_id = ? WHERE id = ?').run(customerId, userId);
    },
    findUserByBillingCustomer(customerId) {
      return userFromRow(sqlite.prepare('SELECT * FROM users WHERE billing_customer_id = ?').get(customerId));
    },
    markEmailVerified(userId, whenIso) {
      sqlite.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(whenIso, userId);
    },
    setAlertsEnabled(userId, enabled) {
      sqlite.prepare('UPDATE users SET alerts_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, userId);
    },
    deleteUser(userId) {
      sqlite.prepare('DELETE FROM users WHERE id = ?').run(userId);
    },
    deleteUserSessions(userId) {
      sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    },
    createEmailToken({ userId, purpose, tokenHash, expiresAt, createdAt }) {
      sqlite.prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
      sqlite.prepare(
        'INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(userId, purpose, tokenHash, expiresAt, createdAt);
    },
    findEmailToken(tokenHash, purpose) {
      const row = sqlite.prepare(
        'SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ?',
      ).get(tokenHash, purpose);
      if (!row) return null;
      return {
        id: row.id,
        userId: row.user_id,
        purpose: row.purpose,
        expiresAt: row.expires_at,
      };
    },
    deleteEmailTokens(userId, purpose) {
      sqlite.prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
    },
    claimBillingEvent(id, receivedAt) {
      try {
        sqlite.prepare('INSERT INTO billing_events (id, received_at) VALUES (?, ?)').run(id, receivedAt);
        return true;
      } catch (err) {
        if (String(err.message).includes('UNIQUE') || String(err.message).includes('PRIMARY')) return false;
        throw err;
      }
    },
    forgetBillingEvent(id) {
      sqlite.prepare('DELETE FROM billing_events WHERE id = ?').run(id);
    },
    createSession({ token, userId, expiresAt }) {
      sqlite.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
    },
    findSession(token) {
      const row = sqlite.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
      if (!row) return null;
      return { token: row.token, userId: row.user_id, expiresAt: row.expires_at };
    },
    deleteSession(token) {
      sqlite.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    },
    countMonitors(userId) {
      return sqlite.prepare('SELECT COUNT(*) AS n FROM monitors WHERE user_id = ?').get(userId).n;
    },
    listMonitors(userId) {
      return sqlite.prepare(`${MONITOR_SELECT} WHERE monitors.user_id = ? ORDER BY monitors.id DESC`).all(userId).map(monitorFromRow);
    },
    findMonitor(id, userId) {
      return monitorFromRow(sqlite.prepare(`${MONITOR_SELECT} WHERE monitors.id = ? AND monitors.user_id = ?`).get(id, userId));
    },
    findDuplicate(userId, url, selector, mode) {
      return sqlite.prepare(
        'SELECT id FROM monitors WHERE user_id = ? AND url = ? AND selector = ? AND mode = ?',
      ).get(userId, url, selector, mode) || null;
    },
    createMonitor(row) {
      const info = sqlite.prepare(`
        INSERT INTO monitors (user_id, url, label, selector, mode, frequency, created_at, next_check_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row.userId, row.url, row.label, row.selector, row.mode, row.frequency, row.createdAt, row.nextCheckAt);
      return this.findMonitor(Number(info.lastInsertRowid), row.userId);
    },
    deleteMonitor(id, userId) {
      return sqlite.prepare('DELETE FROM monitors WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
    },
    listDue(nowIso, limit = 25) {
      return sqlite.prepare(`${MONITOR_SELECT} WHERE monitors.next_check_at <= ? ORDER BY monitors.next_check_at ASC LIMIT ?`).all(nowIso, limit).map(monitorFromRow);
    },
    finishCheck(id, { status, error = '', nextCheckAt, checkedAt, contentHash }) {
      sqlite.prepare(`
        UPDATE monitors
        SET last_status = ?, last_error = ?, next_check_at = ?, last_checked_at = ?, content_hash = COALESCE(?, content_hash)
        WHERE id = ?
      `).run(status, error, nextCheckAt, checkedAt, contentHash ?? null, id);
    },
    setMonitorError(id, error) {
      sqlite.prepare('UPDATE monitors SET last_error = ? WHERE id = ?').run(error, id);
    },
    clearError(id) {
      sqlite.prepare("UPDATE monitors SET last_error = '' WHERE id = ?").run(id);
    },
    latestSnapshot(monitorId) {
      return snapshotFromRow(sqlite.prepare(
        'SELECT * FROM snapshots WHERE monitor_id = ? ORDER BY id DESC LIMIT 1',
      ).get(monitorId));
    },
    getSnapshot(id) {
      return snapshotFromRow(sqlite.prepare('SELECT * FROM snapshots WHERE id = ?').get(id));
    },
    recordCheck({ monitorId, snapshot, change, finish }) {
      return transaction(() => {
        const snap = sqlite.prepare(`
          INSERT INTO snapshots (monitor_id, checked_at, content_hash, text, prices_json, http_status)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          monitorId,
          snapshot.checkedAt,
          snapshot.contentHash,
          snapshot.text,
          JSON.stringify(snapshot.prices || []),
          snapshot.httpStatus || 0,
        );
        const snapshotId = Number(snap.lastInsertRowid);
        let changeId = null;
        if (change) {
          const info = sqlite.prepare(`
            INSERT INTO changes (monitor_id, snapshot_id, previous_snapshot_id, summary, diff_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            monitorId,
            snapshotId,
            change.previousSnapshotId,
            change.summary,
            JSON.stringify(change.diff),
            snapshot.checkedAt,
          );
          changeId = Number(info.lastInsertRowid);
        }
        this.finishCheck(monitorId, finish);
        return { snapshotId, changeId };
      });
    },
    listChanges(monitorId, limit = 50) {
      return sqlite.prepare(
        'SELECT * FROM changes WHERE monitor_id = ? ORDER BY id DESC LIMIT ?',
      ).all(monitorId, limit).map(changeFromRow);
    },
    findChange(id, userId) {
      return changeFromRow(sqlite.prepare(`
        SELECT changes.*, monitors.url, monitors.label, users.email AS user_email,
               users.id AS owner_id, users.alerts_enabled AS alerts_enabled
        FROM changes
        JOIN monitors ON monitors.id = changes.monitor_id
        JOIN users ON users.id = monitors.user_id
        WHERE changes.id = ? AND monitors.user_id = ?
      `).get(id, userId));
    },
    listUnalerted(limit = 20) {
      return sqlite.prepare(`
        SELECT changes.*, monitors.url, monitors.label, users.email AS user_email,
               users.id AS owner_id, users.alerts_enabled AS alerts_enabled
        FROM changes
        JOIN monitors ON monitors.id = changes.monitor_id
        JOIN users ON users.id = monitors.user_id
        WHERE changes.alerted_at IS NULL
        ORDER BY changes.id ASC
        LIMIT ?
      `).all(limit).map(changeFromRow);
    },
    claimAlert(id) {
      return sqlite.prepare("UPDATE changes SET alerted_at = '' WHERE id = ? AND alerted_at IS NULL").run(id).changes === 1;
    },
    releaseAlert(id) {
      sqlite.prepare("UPDATE changes SET alerted_at = NULL WHERE id = ? AND alerted_at = ''").run(id);
    },
    markAlerted(id, whenIso) {
      sqlite.prepare("UPDATE changes SET alerted_at = ? WHERE id = ? AND alerted_at = ''").run(whenIso, id);
    },
    getRobots(origin) {
      const row = sqlite.prepare('SELECT * FROM robots_cache WHERE origin = ?').get(origin);
      if (!row) return null;
      return { origin: row.origin, body: row.body, fetchedAt: row.fetched_at, status: row.status };
    },
    putRobots({ origin, body, fetchedAt, status }) {
      sqlite.prepare(`
        INSERT INTO robots_cache (origin, body, fetched_at, status) VALUES (?, ?, ?, ?)
        ON CONFLICT(origin) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at, status = excluded.status
      `).run(origin, body, fetchedAt, status);
    },
  };
}
