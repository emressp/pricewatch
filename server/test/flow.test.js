import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { buildContext } from '../src/bootstrap.js';
import { checkDueMonitors } from '../src/checker.js';

async function start() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pw-'));
  const outbox = path.join(dir, 'outbox');
  const ctx = await buildContext({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    OUTBOX_DIR: outbox,
    SESSION_SECRET: 'test-secret',
    ALLOW_LOCAL_FETCH: '1',
    DEMO_ENABLED: '1',
    FETCH_MIN_INTERVAL_MS: '0',
    LOG_MAIL: '0',
    MAIL_OUTBOX: '1',
    CHECKER_ENABLED: '0',
    APP_BASE_URL: 'http://127.0.0.1',
  });
  const app = createApp(ctx);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  ctx.config.appBaseUrl = `http://127.0.0.1:${port}`;
  const jar = new Map();
  async function request(urlPath, { method = 'GET', form, body, headers } = {}) {
    const payload = form ? { ...form } : null;
    if (payload && payload._csrf == null && jar.has('pw_csrf')) payload._csrf = decodeURIComponent(jar.get('pw_csrf'));
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(payload ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(jar.has('pw_csrf') ? { 'x-csrf-token': decodeURIComponent(jar.get('pw_csrf')) } : {}),
        ...(jar.size ? { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...headers,
      },
      body: payload ? new URLSearchParams(payload).toString() : body,
    });
    for (const item of response.headers.getSetCookie?.() || []) {
      const pair = item.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
    return {
      status: response.status,
      location: response.headers.get('location') || '',
      text: await response.text(),
    };
  }
  return {
    ctx,
    port,
    request,
    outbox,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      ctx.db.close();
    },
  };
}

test('the marketing pages and the app shell are served together', async () => {
  const app = await start();
  try {
    const home = await app.request('/');
    assert.equal(home.status, 200);
    assert.match(home.text, /Website Change Monitor/);
    assert.match(home.text, /href="app\/"/);
    assert.match(home.text, /<h3>Watch<\/h3>/);
    assert.match(home.text, /<h3>Seller<\/h3>/);
    assert.match(home.text, /<h3>Research<\/h3>/);
    assert.match(home.text, /\$19/);
    assert.match(home.text, /\$49/);
    assert.match(home.text, /3 pages, checked daily/);
    assert.match(home.text, /data-app="\/app\/signup"/);
    assert.doesNotMatch(home.text, /\$99/);
    assert.doesNotMatch(home.text, /Scout/);
    const plans = await app.request('/monitor/');
    assert.equal(plans.status, 200);
    assert.match(plans.text, /Research/);
    assert.match(plans.text, /\$49/);
    assert.match(plans.text, /3 URLs/);
    const entry = await app.request('/app');
    assert.equal(entry.status, 302);
    assert.equal(entry.location, '/app/signup');
    const signup = await app.request('/app/signup');
    assert.match(signup.text, /Create free account/);
    assert.doesNotMatch(signup.text, /npm install/);
  } finally {
    await app.close();
  }
});

test('a sample page change is detected and an alert email is written', async () => {
  const app = await start();
  try {
    await app.request('/app/signup');
    const signup = await app.request('/app/signup', {
      method: 'POST',
      form: { email: 'ada@example.com', password: 'correct-horse' },
    });
    assert.equal(signup.status, 303);
    const verifyMail = await readFile(path.join(app.outbox, (await listOutbox(app.outbox))[0]), 'utf8');
    const token = verifyMail.match(/token=([a-f0-9]+)/)[1];
    const verified = await app.request(`/app/verify?token=${token}`);
    assert.equal(verified.status, 303);

    const created = await app.request('/app/monitors', {
      method: 'POST',
      form: {
        url: `http://127.0.0.1:${app.port}/demo/page`,
        label: 'Northwind',
        mode: 'price',
        frequency: 'daily',
      },
    });
    assert.equal(created.status, 303);
    const monitorPath = created.location;
    assert.match(monitorPath, /^\/app\/monitors\/\d+$/);

    const hourly = await app.request('/app/monitors', {
      method: 'POST',
      form: { url: 'https://example.com/hourly', mode: 'price', frequency: 'hourly' },
    });
    assert.equal(hourly.status, 400);
    assert.match(hourly.text, /Hourly/);

    const blocked = await app.request('/app/monitors', {
      method: 'POST',
      form: { url: 'http://169.254.169.254/latest/meta-data', mode: 'all', frequency: 'daily' },
    });
    assert.equal(blocked.status, 400);
    assert.match(blocked.text, /not allowed/);

    const first = await checkDueMonitors(app.ctx);
    assert.equal(first.length, 1);
    assert.equal(first[0].status, 'baseline');
    assert.equal((await Promise.all((await listOutbox(app.outbox)).map((name) => readFile(path.join(app.outbox, name), 'utf8')))).some((text) => text.includes('Old vs new:')), false);

    const baselinePage = await app.request(monitorPath);
    assert.match(baselinePage.text, /Baseline saved/);
    assert.match(baselinePage.text, /Trail kit/);
    assert.doesNotMatch(baselinePage.text, /Accept all cookies/);
    assert.doesNotMatch(baselinePage.text, /2026-11-01T08:00:00Z/);

    const edited = await app.request('/demo/page', {
      method: 'POST',
      body: (await import('../src/demo-page.js')).CHANGED_DEMO_HTML,
      headers: { 'content-type': 'text/html' },
    });
    assert.equal(edited.status, 200);

    const checked = await app.request(`${monitorPath}/check`, { method: 'POST' });
    assert.equal(checked.status, 303);
    assert.match(checked.location, /^\/app\/changes\/\d+$/);
    const diffPage = await app.request(checked.location);
    assert.match(diffPage.text, /Previous/);
    assert.match(diffPage.text, /Current/);
    assert.match(diffPage.text, /\$29\/mo/);
    assert.match(diffPage.text, /\$34\/mo/);
    assert.match(diffPage.text, /Expedition pack/);
    assert.match(diffPage.text, /Alert email sent/);
    assert.doesNotMatch(diffPage.text, /5 business days/);

    const files = await listOutbox(app.outbox);
    const emails = await Promise.all(files.map((name) => readFile(path.join(app.outbox, name), 'utf8')));
    const email = emails.find((text) => text.includes('Old vs new:'));
    assert.ok(email);
    assert.match(email, /To: ada@example.com/);
    assert.match(email, /Trail kit: \$29\/mo → \$34\/mo/);
    assert.match(email, /Old vs new:/);
    assert.ok(email.includes(checked.location), email);
    assert.doesNotMatch(email, /2026-11-09T18:45:00Z/);

    for (const suffix of ['/a', '/b']) {
      const extra = await app.request('/app/monitors', {
        method: 'POST',
        form: { url: `https://example.com${suffix}`, mode: 'all', frequency: 'daily' },
      });
      assert.equal(extra.status, 303);
    }
    const over = await app.request('/app/monitors', {
      method: 'POST',
      form: { url: 'https://example.com/c', mode: 'all', frequency: 'daily' },
    });
    assert.equal(over.status, 400);
    assert.match(over.text, /3 URLs/);
  } finally {
    await app.close();
  }
});

async function listOutbox(dir) {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.txt'));
  } catch {
    return [];
  }
}
