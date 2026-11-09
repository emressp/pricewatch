import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBillingEvent, interpretBillingEvent, signWebhook } from '../src/billing.js';
import { createApp } from '../src/app.js';
import { buildContext } from '../src/bootstrap.js';

const SECRET = 'whsec_test_secret_value';
const config = {
  polarSellerProductId: 'prod_seller',
  polarResearchProductId: 'prod_research',
};

function subscriptionEvent(type, overrides = {}) {
  return {
    type,
    data: {
      id: 'sub_1',
      status: 'active',
      product_id: 'prod_seller',
      customer_id: 'cus_1',
      customer: { id: 'cus_1', email: 'ada@example.com', external_id: '7' },
      metadata: { user_id: '7' },
      ...overrides,
    },
  };
}

test('Polar subscription events set and clear the Change Monitor plan', () => {
  assert.equal(interpretBillingEvent(subscriptionEvent('subscription.active'), config).plan, 'seller');
  assert.equal(interpretBillingEvent(subscriptionEvent('subscription.created', { product_id: 'prod_research' }), config).plan, 'research');
  assert.equal(interpretBillingEvent(subscriptionEvent('subscription.canceled', { status: 'active' }), config).plan, 'free');
  assert.equal(interpretBillingEvent(subscriptionEvent('subscription.revoked', { status: 'revoked' }), config).plan, 'free');
  assert.equal(interpretBillingEvent(subscriptionEvent('subscription.updated', { status: 'past_due' }), config).plan, 'free');
  assert.equal(interpretBillingEvent(subscriptionEvent('subscription.active', { product_id: 'prod_weekly_scout' }), config).ignore, true);
  assert.equal(interpretBillingEvent({ type: 'order.paid', data: {} }, config).ignore, true);
});

test('applying a signed Polar webhook updates the user and ignores repeats', async () => {
  const ctx = buildContext({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    SESSION_SECRET: 'test-secret',
    POLAR_WEBHOOK_SECRET: SECRET,
    POLAR_SELLER_PRODUCT_ID: 'prod_seller',
    POLAR_RESEARCH_PRODUCT_ID: 'prod_research',
    LOG_MAIL: '0',
    MAIL_OUTBOX: '0',
  });
  const user = ctx.db.createUser({
    email: 'ada@example.com',
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
  });
  const event = subscriptionEvent('subscription.active', {
    customer: { id: 'cus_1', email: user.email, external_id: String(user.id) },
    metadata: { user_id: String(user.id) },
  });
  const body = JSON.stringify(event);
  const headers = signWebhook(body, SECRET, { id: 'msg_1' });
  const server = createApp(ctx).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const post = (signature) => fetch(`http://127.0.0.1:${port}/polar/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signature },
    body,
  });
  const ok = await post(headers);
  assert.equal(ok.status, 202);
  assert.equal(ctx.db.findUserById(user.id).plan, 'seller');
  assert.equal(ctx.db.findUserById(user.id).billingCustomerId, 'cus_1');
  const again = await post(headers);
  assert.equal(again.status, 202);
  const bad = await post({ ...headers, 'webhook-signature': 'v1,bm90LWEtcmVhbC1zaWduYXR1cmU=' });
  assert.equal(bad.status, 403);
  const canceled = subscriptionEvent('subscription.canceled', {
    customer: { id: 'cus_1', email: user.email, external_id: String(user.id) },
  });
  const cancelBody = JSON.stringify(canceled);
  const cancelHeaders = signWebhook(cancelBody, SECRET, { id: 'msg_2' });
  const cleared = await fetch(`http://127.0.0.1:${port}/polar/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cancelHeaders },
    body: cancelBody,
  });
  assert.equal(cleared.status, 202);
  assert.equal(ctx.db.findUserById(user.id).plan, 'free');
  const applied = applyBillingEvent(ctx.db, canceled, ctx.config, { deliveryId: 'msg_2' });
  assert.equal(applied.duplicate, true);
  await new Promise((resolve) => server.close(resolve));
  ctx.db.close();
});
