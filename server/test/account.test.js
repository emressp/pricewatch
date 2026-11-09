import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { buildContext } from '../src/bootstrap.js';
import { createRateLimiter } from '../src/rate-limit.js';

test('auth posts without a csrf token are rejected, and password reset works', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pw-account-'));
  const ctx = buildContext({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    OUTBOX_DIR: path.join(dir, 'outbox'),
    SESSION_SECRET: 'test-secret',
    LOG_MAIL: '0',
    MAIL_OUTBOX: '1',
    APP_BASE_URL: 'http://127.0.0.1',
  });
  const server = createApp(ctx).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  ctx.config.appBaseUrl = `http://127.0.0.1:${port}`;
  const jar = new Map();
  async function request(urlPath, { method = 'GET', form } = {}) {
    const payload = form ? { ...form } : null;
    if (payload && payload._csrf == null && jar.has('pw_csrf')) payload._csrf = decodeURIComponent(jar.get('pw_csrf'));
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(payload ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(jar.has('pw_csrf') ? { 'x-csrf-token': decodeURIComponent(jar.get('pw_csrf')) } : {}),
        ...(jar.size ? { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
      },
      body: payload ? new URLSearchParams(payload).toString() : undefined,
    });
    for (const item of response.headers.getSetCookie?.() || []) {
      const pair = item.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
    return { status: response.status, text: await response.text() };
  }

  const bare = await fetch(`http://127.0.0.1:${port}/app/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=a@b.co&password=correct-horse',
  });
  assert.equal(bare.status, 403);

  await request('/app/signup');
  assert.equal((await request('/app/signup', { method: 'POST', form: { email: 'ada@example.com', password: 'correct-horse' } })).status, 303);
  await request('/app/forgot');
  assert.equal((await request('/app/forgot', { method: 'POST', form: { email: 'ada@example.com' } })).status, 303);
  const files = await readdir(path.join(dir, 'outbox'));
  const bodies = await Promise.all(files.map((name) => readFile(path.join(dir, 'outbox', name), 'utf8')));
  const reset = bodies.find((text) => text.includes('/app/reset?token='));
  const token = reset.match(/token=([a-f0-9]+)/)[1];
  await request(`/app/reset?token=${token}`);
  assert.equal((await request('/app/reset', { method: 'POST', form: { token, password: 'new-password-1' } })).status, 303);
  jar.delete('pw_session');
  await request('/app/login');
  const oldPassword = await request('/app/login', { method: 'POST', form: { email: 'ada@example.com', password: 'correct-horse' } });
  assert.equal(oldPassword.status, 400);
  const loggedIn = await request('/app/login', { method: 'POST', form: { email: 'ada@example.com', password: 'new-password-1' } });
  assert.equal(loggedIn.status, 303);

  await new Promise((resolve) => server.close(resolve));
  ctx.db.close();
});

test('the auth rate limiter blocks the next attempt in the window', () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
  assert.equal(limiter.allow('ip'), true);
  assert.equal(limiter.allow('ip'), true);
  assert.equal(limiter.allow('ip'), false);
  assert.equal(limiter.allow('other'), true);
});
