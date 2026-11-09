import { createApp } from '../src/app.js';
import { buildContext } from '../src/bootstrap.js';
import { checkDueMonitors } from '../src/checker.js';
import { CHANGED_DEMO_HTML } from '../src/demo-page.js';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'pw-demo-'));
const outbox = path.join(dir, 'outbox');
const ctx = buildContext({
  NODE_ENV: 'development',
  DATABASE_PATH: path.join(dir, 'pricewatch.sqlite'),
  OUTBOX_DIR: outbox,
  SESSION_SECRET: 'demo-secret',
  ALLOW_LOCAL_FETCH: '1',
  DEMO_ENABLED: '1',
  FETCH_MIN_INTERVAL_MS: '0',
  LOG_MAIL: '0',
  MAIL_OUTBOX: '1',
  APP_BASE_URL: 'http://127.0.0.1',
});

const server = createApp(ctx).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
ctx.config.appBaseUrl = base;

const jar = new Map();
async function request(urlPath, { method = 'GET', form, body, headers } = {}) {
  const response = await fetch(base + urlPath, {
    method,
    redirect: 'manual',
    headers: {
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(jar.size ? { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
      ...headers,
    },
    body: form ? new URLSearchParams(form).toString() : body,
  });
  for (const item of response.headers.getSetCookie?.() || []) {
    const pair = item.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
  return { status: response.status, location: response.headers.get('location') || '', text: await response.text() };
}

const signup = await request('/app/signup', {
  method: 'POST',
  form: { email: 'demo@example.com', password: 'correct-horse' },
});
if (signup.status !== 303) throw new Error(`signup failed (${signup.status})`);

const created = await request('/app/monitors', {
  method: 'POST',
  form: { url: `${base}/demo/page`, label: 'Northwind sample', mode: 'price', frequency: 'daily' },
});
if (created.status !== 303) throw new Error(`create monitor failed (${created.status})`);

const first = await checkDueMonitors(ctx);
console.log(`Signed up as demo@example.com and added ${base}/demo/page`);
console.log(`First check: ${first[0]?.status || 'none'} (no email yet)`);

const edited = await request('/demo/page', {
  method: 'POST',
  body: CHANGED_DEMO_HTML,
  headers: { 'content-type': 'text/html' },
});
if (edited.status !== 200) throw new Error('could not update the sample page');

const checked = await request(`${created.location}/check`, { method: 'POST' });
if (!checked.location.startsWith('/app/changes/')) {
  throw new Error(`expected a change page, got ${checked.status} ${checked.location}`);
}

const files = (await readdir(outbox)).filter((name) => name.endsWith('.txt'));
if (files.length !== 1) throw new Error(`expected 1 alert email, found ${files.length}`);
const email = await readFile(path.join(outbox, files[0]), 'utf8');
console.log('Updated the sample: Trail kit $29/mo → $34/mo, removed Base camp, added Expedition pack.');
console.log(`Second check: change ${base}${checked.location}`);
console.log(`Alert email written to ${path.join(outbox, files[0])}`);
console.log('\n----- email -----\n');
console.log(email.trim());
console.log('\n----- end -----\n');

await new Promise((resolve) => server.close(resolve));
ctx.db.close();
