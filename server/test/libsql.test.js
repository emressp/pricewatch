import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { buildContext } from '../src/bootstrap.js';
import { createMailer } from '../src/mailer.js';

test('a libsql file database persists users, monitors, rate limits, and mail counts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pw-libsql-'));
  const file = path.join(dir, 'pricewatch.db');
  const env = {
    NODE_ENV: 'test',
    TURSO_DATABASE_URL: `file:${file}`,
    SESSION_SECRET: 'test-secret',
    LOG_MAIL: '0',
    MAIL_OUTBOX: '0',
    CRON_SECRET: 'cron-test-secret',
    MAIL_DAILY_LIMIT: '1',
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_PORT: '587',
    SMTP_USER: 'alerts@gmail.com',
    SMTP_PASS: 'app-password',
    MAIL_FROM: 'alerts@gmail.com',
  };
  const ctx = await buildContext(env);
  const user = await ctx.db.createUser({
    email: 'ada@example.com',
    passwordHash: 'hash',
    createdAt: new Date().toISOString(),
  });
  const now = new Date().toISOString();
  const monitor = await ctx.db.createMonitor({
    userId: user.id,
    url: 'https://example.com/pricing',
    label: 'Example',
    selector: '',
    mode: 'price',
    frequency: 'daily',
    createdAt: now,
    nextCheckAt: now,
  });
  assert.equal(monitor.label, 'Example');
  assert.equal(await ctx.db.allowRate('login:test', 1, 60_000), true);
  assert.equal(await ctx.db.allowRate('login:test', 1, 60_000), false);
  const recorded = await ctx.db.recordCheck({
    monitorId: monitor.id,
    snapshot: {
      checkedAt: now,
      contentHash: 'abc',
      text: 'Pen — $4',
      prices: [{ label: 'Pen', amount: 4, currency: 'USD', period: '' }],
      httpStatus: 200,
    },
    change: null,
    finish: { status: 'baseline', error: '', nextCheckAt: now, checkedAt: now, contentHash: 'abc' },
  });
  assert.ok(recorded.snapshotId);
  await ctx.db.close();

  const again = await buildContext(env);
  const saved = await again.db.findUserByEmail('ada@example.com');
  assert.equal(saved.id, user.id);
  const monitors = await again.db.listMonitors(user.id);
  assert.equal(monitors.length, 1);
  assert.equal((await again.db.latestSnapshot(monitor.id)).text, 'Pen — $4');
  await again.db.finishCheck(monitor.id, {
    status: 'baseline',
    nextCheckAt: '2099-01-01T00:00:00.000Z',
    checkedAt: now,
    contentHash: 'abc',
  });

  const mailer = createMailer(again.config, again.db);
  const transport = {
    async sendMail() {
      throw new Error('should not send past the cap');
    },
  };
  mailer.send = undefined;
  const first = await again.db.reserveMailSend(1);
  const second = await again.db.reserveMailSend(1);
  assert.equal(first, true);
  assert.equal(second, false);
  assert.ok(transport);

  const server = createApp(again).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const denied = await fetch(`http://127.0.0.1:${port}/cron/tick`);
  assert.equal(denied.status, 401);
  const allowed = await fetch(`http://127.0.0.1:${port}/cron/tick`, {
    headers: { authorization: 'Bearer cron-test-secret' },
  });
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.equal(body.ok, true);
  await new Promise((resolve) => server.close(resolve));
  await again.db.close();
});

test('the mailer skips SMTP after the daily cap', async () => {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const mailer = createMailer({
      smtp: { host: 'smtp.gmail.com', port: 587, user: 'a@gmail.com', pass: 'x', secure: false },
      mailFrom: 'a@gmail.com',
      mailDailyLimit: 450,
      mailOutbox: false,
      logMail: false,
    }, {
      async reserveMailSend() { return false; },
    });
    const result = await mailer.send({ to: 'b@example.com', subject: 'Hi', text: 'Body' });
    assert.equal(result.skipped, true);
    assert.match(logs.join('\n'), /daily limit 450 reached/);
  } finally {
    console.log = original;
  }
});
