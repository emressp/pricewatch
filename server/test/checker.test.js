import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMonitor } from '../src/checker.js';
import { buildContext } from '../src/bootstrap.js';

function context() {
  return buildContext({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    ALLOW_LOCAL_FETCH: '1',
    FETCH_MIN_INTERVAL_MS: '0',
    LOG_MAIL: '0',
    MAIL_OUTBOX: '0',
    APP_BASE_URL: 'http://127.0.0.1',
    USER_AGENT: 'PricewatchBot/1.0',
  });
}

function seed(ctx) {
  const user = ctx.db.createUser({
    email: 'ada@example.com',
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
  });
  return ctx.db.createMonitor({
    userId: user.id,
    url: 'http://127.0.0.1/secret',
    label: 'Secret',
    selector: '',
    mode: 'price',
    frequency: 'daily',
    createdAt: new Date().toISOString(),
    nextCheckAt: new Date().toISOString(),
  });
}

test('a disallowed robots.txt path is not fetched', async () => {
  const ctx = context();
  const calls = [];
  ctx.fetchImpl = async (url, options) => {
    calls.push({ href: String(url), ua: options.headers['user-agent'] });
    if (String(url).endsWith('/robots.txt')) {
      return new Response('User-agent: *\nDisallow: /secret\n', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return new Response('<p>Secret — $9</p>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const monitor = seed(ctx);
  const result = await checkMonitor(ctx, ctx.db.findMonitor(monitor.id, monitor.userId));
  assert.equal(result.status, 'blocked');
  assert.equal(calls.some((call) => call.href.includes('/secret') && !call.href.endsWith('/robots.txt')), false);
  ctx.db.close();
});

test('an allowed page is fetched with the Pricewatch user agent and can alert', async () => {
  const ctx = context();
  const sent = [];
  ctx.mailer = { async send(message) { sent.push(message); } };
  let html = '<html><body><p>Pen — $4</p></body></html>';
  const calls = [];
  ctx.fetchImpl = async (url, options) => {
    calls.push(options.headers['user-agent']);
    if (String(url).endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const monitor = seed(ctx);
  const loaded = () => ctx.db.findMonitor(monitor.id, monitor.userId);
  const first = await checkMonitor(ctx, loaded());
  assert.equal(first.status, 'baseline');
  assert.equal(sent.length, 0);
  html = '<html><body><p>Pen — $6</p></body></html>';
  const second = await checkMonitor(ctx, loaded());
  assert.equal(second.status, 'changed');
  assert.equal(second.summary, 'Pen: $4 → $6');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\$4 → \$6|Pen: \$4 → \$6/);
  assert.equal(calls[0], 'PricewatchBot/1.0');
  ctx.db.close();
});
