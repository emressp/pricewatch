import { createHmac } from 'node:crypto';
import { createPolar, webhooks } from '@polar-sh/sdk/2026-10';

const GRANT_EVENTS = new Set(['subscription.created', 'subscription.active', 'subscription.updated']);
const CLEAR_EVENTS = new Set(['subscription.canceled', 'subscription.revoked']);
const ACTIVE_STATUSES = new Set(['active', 'trialing']);
const ENDED_STATUSES = new Set(['canceled', 'revoked', 'incomplete', 'incomplete_expired', 'past_due', 'unpaid']);

export function productToPlan(productId, config) {
  if (!productId) return null;
  if (productId === config.polarSellerProductId) return 'seller';
  if (productId === config.polarResearchProductId) return 'research';
  return null;
}

function subscriptionOf(event) {
  return event?.data || {};
}

function customerOf(subscription) {
  return subscription.customer || {};
}

function externalUserId(subscription) {
  const customer = customerOf(subscription);
  return String(
    customer.external_id
    || customer.externalId
    || subscription.metadata?.user_id
    || subscription.metadata?.userId
    || '',
  );
}

export function interpretBillingEvent(event, config) {
  const type = event?.type;
  if (!GRANT_EVENTS.has(type) && !CLEAR_EVENTS.has(type)) return { ignore: true };
  const subscription = subscriptionOf(event);
  const productId = subscription.product_id || subscription.productId || subscription.product?.id || '';
  const mapped = productToPlan(productId, config);
  if (!mapped) return { ignore: true, reason: 'product is not a Change Monitor plan' };
  const identity = {
    userId: externalUserId(subscription),
    customerId: String(subscription.customer_id || subscription.customerId || customerOf(subscription).id || ''),
    email: String(customerOf(subscription).email || '').toLowerCase(),
  };
  const status = subscription.status || (type === 'subscription.active' ? 'active' : '');
  if (CLEAR_EVENTS.has(type)) return { ...identity, plan: 'free' };
  if (ACTIVE_STATUSES.has(status)) return { ...identity, plan: mapped };
  if (type === 'subscription.updated' && ENDED_STATUSES.has(status)) return { ...identity, plan: 'free' };
  return { ignore: true };
}

function findBillingUser(db, decision) {
  const userId = Number(decision.userId);
  if (userId) {
    const byId = db.findUserById(userId);
    if (byId) return byId;
  }
  if (decision.customerId) {
    const byCustomer = db.findUserByBillingCustomer(decision.customerId);
    if (byCustomer) return byCustomer;
  }
  if (decision.email) return db.findUserByEmail(decision.email);
  return null;
}

export function applyBillingEvent(db, event, config, { deliveryId } = {}) {
  const id = String(deliveryId || event?.id || '');
  if (!id) return { ok: false, status: 400, error: 'Missing event id' };
  if (!db.claimBillingEvent(id, new Date().toISOString())) return { ok: true, duplicate: true };
  try {
    const decision = interpretBillingEvent(event, config);
    if (decision.ignore) return { ok: true, ignored: true, reason: decision.reason || '' };
    const user = findBillingUser(db, decision);
    if (!user) return { ok: true, missingUser: true };
    db.setPlan(user.id, decision.plan);
    if (decision.customerId) db.setBillingCustomer(user.id, decision.customerId);
    return { ok: true, userId: user.id, plan: decision.plan };
  } catch (err) {
    db.forgetBillingEvent(id);
    throw err;
  }
}

export function signWebhook(body, secret, { id = 'msg_test', timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const signed = `${id}.${timestamp}.${payload}`;
  const signature = createHmac('sha256', secret).update(signed).digest('base64');
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}`,
  };
}

export function createBillingProvider(config) {
  const polar = config.polarAccessToken
    ? createPolar({
      accessToken: config.polarAccessToken,
      environment: config.polarServer === 'sandbox' ? 'sandbox' : 'production',
    })
    : null;

  return {
    id: 'polar',
    configured: Boolean(polar),
    productIdFor(plan) {
      if (plan === 'seller') return config.polarSellerProductId;
      if (plan === 'research') return config.polarResearchProductId;
      return '';
    },
    async createCheckout({ user, plan, customerIp }) {
      if (!polar) {
        const error = new Error('Polar is not configured. Set POLAR_ACCESS_TOKEN.');
        error.status = 503;
        throw error;
      }
      const productId = this.productIdFor(plan);
      if (!productId) {
        const error = new Error('That plan has no Polar product id yet.');
        error.status = 503;
        throw error;
      }
      const checkout = await polar.checkouts.create({
        products: [productId],
        external_customer_id: String(user.id),
        customer_email: user.email,
        customer_ip_address: customerIp || null,
        success_url: `${config.appBaseUrl}/app/settings?notice=${encodeURIComponent('Payment received. Your plan updates when Polar confirms it.')}`,
        return_url: `${config.appBaseUrl}/app/settings`,
        metadata: { user_id: String(user.id), plan },
      });
      return { url: checkout.url };
    },
    async createPortal({ user }) {
      if (!polar) {
        const error = new Error('Polar is not configured. Set POLAR_ACCESS_TOKEN.');
        error.status = 503;
        throw error;
      }
      const session = await polar.customerSessions.create({
        external_customer_id: String(user.id),
        return_url: `${config.appBaseUrl}/app/settings`,
      });
      const url = session.customer_portal_url || session.customerPortalUrl;
      if (!url) {
        const error = new Error('Polar did not return a customer portal link.');
        error.status = 502;
        throw error;
      }
      return { url };
    },
    async verifyWebhook(rawBody, headers) {
      if (!config.polarWebhookSecret) {
        const error = new Error('POLAR_WEBHOOK_SECRET is not set');
        error.status = 503;
        throw error;
      }
      const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));
      return webhooks.validateEvent(payload, {
        'webhook-id': headers['webhook-id'] || '',
        'webhook-timestamp': headers['webhook-timestamp'] || '',
        'webhook-signature': headers['webhook-signature'] || '',
      }, config.polarWebhookSecret);
    },
  };
}
