import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublicHttpUrl, assertResolvedHost, createHostLimiter, isBlockedHost } from '../src/net.js';

test('private and link-local hosts are refused, loopback only when allowed', () => {
  for (const host of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.16.0.4', '169.254.169.254', 'localhost', '::1', 'metadata.google.internal']) {
    assert.equal(isBlockedHost(host), true, host);
  }
  assert.equal(isBlockedHost('example.com'), false);
  assert.equal(isBlockedHost('8.8.8.8'), false);

  const local = assertPublicHttpUrl('http://127.0.0.1/demo/page', { allowLocal: true });
  assert.equal(local.hostname, '127.0.0.1');
  assert.throws(() => assertPublicHttpUrl('http://169.254.169.254/latest', { allowLocal: true }), /not allowed/);
  assert.throws(() => assertPublicHttpUrl('http://127.0.0.1/', { allowLocal: false }), /not allowed/);
  assert.throws(() => assertPublicHttpUrl('javascript:alert(1)'), /http and https/);
  assert.throws(() => assertPublicHttpUrl('http://user:pass@example.com/'), /username or password/);
});

test('resolved private addresses are refused', async () => {
  await assert.rejects(
    () => assertResolvedHost(new URL('http://10.0.0.8/'), { allowLocal: true }),
    /not allowed/,
  );
  await assert.rejects(
    () => assertResolvedHost(new URL('http://shop.example/pricing'), {
      allowLocal: false,
      lookup: async () => [{ address: '192.168.0.9', family: 4 }],
    }),
    /not allowed/,
  );
  await assertResolvedHost(new URL('http://127.0.0.1/demo'), { allowLocal: true });
});

test('the per-host limiter spaces repeat fetches', async () => {
  const limiter = createHostLimiter({ minIntervalMs: 40 });
  const started = Date.now();
  await limiter.wait('example.com');
  await limiter.wait('example.com');
  assert.ok(Date.now() - started >= 35);
});
