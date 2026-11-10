import express from 'express';
import {
  CSRF_COOKIE, SESSION_COOKIE, SESSION_MS, clearSessionCookie, csrfMatches, hashPassword,
  issueCsrf, newSessionToken, readCookie, sessionCookie, verifyPassword,
} from './auth.js';
import { checkMonitor } from './checker.js';
import { assertPublicHttpUrl } from './net.js';
import { planFor } from './plans.js';
import { hashToken, newToken, readAlertToken } from './tokens.js';
import {
  changePage, dashboardPage, forgotPage, loginPage, monitorPage, newMonitorPage, page,
  resetPage, settingsPage, signupPage,
} from './templates.js';

const HOUR = 60 * 60 * 1000;

export function safeNext(value) {
  if (typeof value !== 'string') return '/app';
  if (value !== '/app' && !value.startsWith('/app/')) return '/app';
  if (value.includes('\\') || value.includes('://')) return '/app';
  return value;
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function createRouter(ctx) {
  const router = express.Router();
  const { db, config } = ctx;

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.use(wrap(async (req, res, next) => {
    req.user = null;
    req.sessionToken = '';
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token) {
      const session = await db.findSession(token);
      const now = new Date().toISOString();
      if (!session || session.expiresAt <= now) {
        if (session) await db.deleteSession(token);
      } else {
        req.user = await db.findUserById(session.userId);
        req.sessionToken = token;
      }
    }
    req.csrfToken = issueCsrf(req, res, { secure: cookieSecure(req) });
    if (req.method !== 'GET' && req.method !== 'HEAD' && !csrfMatches(req)) {
      return res.status(403).type('html').send(page({
        title: 'Form expired',
        user: req.user,
        csrf: req.csrfToken,
        width: 640,
        body: '<div class="card"><h1>Form expired</h1><p>Refresh the page and try again.</p></div>',
      }));
    }
    return next();
  }));

  function cookieSecure(req) {
    return config.nodeEnv === 'production' || Boolean(req.secure);
  }

  async function startSession(res, req, user) {
    const token = newSessionToken();
    const expires = new Date(Date.now() + SESSION_MS).toISOString();
    await db.createSession({ token, userId: user.id, expiresAt: expires });
    res.append('Set-Cookie', sessionCookie(token, { secure: cookieSecure(req) }));
  }

  async function limited(key, limit, windowMs, res) {
    if (await db.allowRate(key, limit, windowMs)) return false;
    res.status(429).type('html').send(page({
      title: 'Slow down',
      user: null,
      width: 640,
      body: '<div class="card"><h1>Too many attempts</h1><p>Wait a few minutes and try again.</p></div>',
    }));
    return true;
  }

  router.get('/', wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, '/app/signup');
    res.type('html').send(dashboardPage({
      user: req.user,
      monitors: await db.listMonitors(req.user.id),
      config,
      notice: String(req.query.notice || ''),
      error: String(req.query.error || ''),
      demoUrl: absoluteDemo(req),
      csrf: req.csrfToken,
    }));
  }));

  router.get('/signup', (req, res) => {
    if (req.user) return res.redirect(302, '/app');
    res.type('html').send(signupPage({ csrf: req.csrfToken }));
  });

  router.post('/signup', wrap(async (req, res) => {
    if (await limited(`signup:${req.ip}`, config.authRateLimit, config.authRateWindowMs, res)) return;
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email || password.length < 8 || password.length > 200) {
      return res.status(400).type('html').send(signupPage({
        error: 'Enter an email and a password of at least 8 characters.',
        email,
        csrf: req.csrfToken,
      }));
    }
    const user = await db.createUser({
      email,
      passwordHash: await hashPassword(password),
      createdAt: new Date().toISOString(),
    });
    if (!user) {
      return res.status(400).type('html').send(signupPage({
        error: 'That email already has an account. Log in instead.',
        email,
        csrf: req.csrfToken,
      }));
    }
    await sendVerifyEmail(ctx, user);
    await startSession(res, req, user);
    res.redirect(303, '/app?notice=Check+your+email+to+confirm+this+address');
  }));

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(302, '/app');
    res.type('html').send(loginPage({ csrf: req.csrfToken, notice: String(req.query.notice || '') }));
  });

  router.post('/login', wrap(async (req, res) => {
    if (await limited(`login:${req.ip}`, config.authRateLimit, config.authRateWindowMs, res)) return;
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const user = email ? await db.findUserByEmail(email) : null;
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!ok) {
      return res.status(400).type('html').send(loginPage({
        error: 'Email or password is not right.',
        email,
        csrf: req.csrfToken,
      }));
    }
    await startSession(res, req, user);
    res.redirect(303, '/app');
  }));

  router.post('/logout', wrap(async (req, res) => {
    if (req.sessionToken) await db.deleteSession(req.sessionToken);
    res.append('Set-Cookie', clearSessionCookie());
    res.redirect(303, '/app/login');
  }));

  router.get('/forgot', (req, res) => {
    res.type('html').send(forgotPage({ csrf: req.csrfToken, notice: String(req.query.notice || '') }));
  });

  router.post('/forgot', wrap(async (req, res) => {
    if (await limited(`forgot:${req.ip}`, config.authRateLimit, config.authRateWindowMs, res)) return;
    const email = normalizeEmail(req.body?.email);
    const user = email ? await db.findUserByEmail(email) : null;
    if (user) await sendResetEmail(ctx, user);
    res.redirect(303, '/app/forgot?notice=If+that+account+exists%2C+we+sent+a+reset+link');
  }));

  router.get('/reset', (req, res) => {
    res.type('html').send(resetPage({ token: String(req.query.token || ''), csrf: req.csrfToken }));
  });

  router.post('/reset', wrap(async (req, res) => {
    if (await limited(`reset:${req.ip}`, config.authRateLimit, config.authRateWindowMs, res)) return;
    const token = String(req.body?.token || '');
    const password = String(req.body?.password || '');
    const row = token ? await db.findEmailToken(hashToken(token), 'reset') : null;
    if (!row || row.expiresAt < new Date().toISOString() || password.length < 8 || password.length > 200) {
      return res.status(400).type('html').send(resetPage({
        token,
        csrf: req.csrfToken,
        error: 'That reset link is invalid or expired. Request a new one.',
      }));
    }
    await db.setPassword(row.userId, await hashPassword(password));
    await db.deleteEmailTokens(row.userId, 'reset');
    await db.deleteUserSessions(row.userId);
    res.redirect(303, '/app/login?notice=Password+updated.+Log+in+with+the+new+one');
  }));

  router.get('/verify', wrap(async (req, res) => {
    const token = String(req.query.token || '');
    const row = token ? await db.findEmailToken(hashToken(token), 'verify') : null;
    if (!row || row.expiresAt < new Date().toISOString()) {
      return res.status(400).type('html').send(page({
        title: 'Link expired',
        user: req.user,
        csrf: req.csrfToken,
        width: 640,
        body: '<div class="card"><h1>That link has expired</h1><p><a href="/app">Back to your account</a> and send a new confirmation email.</p></div>',
      }));
    }
    await db.markEmailVerified(row.userId, new Date().toISOString());
    await db.deleteEmailTokens(row.userId, 'verify');
    res.redirect(303, '/app?notice=Email+confirmed');
  }));

  router.post('/verify/resend', wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    if (await limited(`verify:${req.user.id}`, config.authRateLimit, config.authRateWindowMs, res)) return;
    if (!req.user.emailVerifiedAt) await sendVerifyEmail(ctx, req.user);
    res.redirect(303, '/app?notice=Confirmation+email+sent');
  }));

  router.get('/settings', wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    res.type('html').send(settingsPage({
      user: await db.findUserById(req.user.id),
      config,
      csrf: req.csrfToken,
      notice: String(req.query.notice || ''),
      error: String(req.query.error || ''),
    }));
  }));

  router.post('/settings/alerts', wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    await db.setAlertsEnabled(req.user.id, req.body?.alerts === '1');
    res.redirect(303, '/app/settings?notice=Alert+settings+saved');
  }));

  router.post('/account/delete', wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    await db.deleteUser(req.user.id);
    res.append('Set-Cookie', clearSessionCookie());
    res.redirect(303, '/app/signup?notice=Account+deleted');
  }));

  router.get('/unsubscribe', wrap(async (req, res) => {
    const parsed = readAlertToken(req.query.token, config.sessionSecret);
    const user = parsed ? await db.findUserById(parsed.id) : null;
    if (!user || user.email !== parsed.email) {
      return res.status(400).type('html').send(page({
        title: 'Unsubscribe',
        width: 640,
        body: '<div class="card"><h1>That unsubscribe link is not valid</h1></div>',
      }));
    }
    await db.setAlertsEnabled(user.id, false);
    res.type('html').send(page({
      title: 'Unsubscribed',
      user: req.user,
      csrf: req.csrfToken,
      width: 640,
      body: `<div class="card"><h1>Alerts are off</h1><p>We will not email ${escapeHtml(user.email)} about page changes. The history stays in your account. <a href="/app/settings">Turn alerts back on</a>.</p></div>`,
    }));
  }));

  router.post('/billing/checkout', wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    const plan = req.body?.plan === 'research' ? 'research' : 'seller';
    try {
      const session = await ctx.billing.createCheckout({
        user: req.user,
        plan,
        customerIp: req.ip,
      });
      res.redirect(303, session.url);
    } catch (err) {
      res.redirect(303, `/app/settings?error=${encodeURIComponent(err.message || 'Checkout failed')}`);
    }
  }));

  router.post('/billing/portal', wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    try {
      const session = await ctx.billing.createPortal({ user: req.user });
      res.redirect(303, session.url);
    } catch (err) {
      res.redirect(303, `/app/settings?error=${encodeURIComponent(err.message || 'Could not open the billing portal')}`);
    }
  }));

  router.get('/monitors/new', (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    const url = validPrefill(req.query.url, config.allowLocalFetch);
    const label = String(req.query.label || '').replace(/[<>]/g, '').trim().slice(0, 120);
    res.type('html').send(newMonitorPage({
      user: req.user,
      values: { url, label, mode: req.query.mode === 'price' ? 'price' : 'all', frequency: 'daily' },
      demoHint: config.demoEnabled ? `Local sample: ${absoluteDemo(req)}` : '',
      csrf: req.csrfToken,
    }));
  });

  router.post('/monitors', wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    if (!await db.allowRate(`url:${req.user.id}`, config.urlRateLimit, config.urlRateWindowMs)) {
      return res.status(429).type('html').send(newMonitorPage({
        user: req.user,
        error: 'Too many URLs added in a short time. Wait and try again.',
        values: {},
        csrf: req.csrfToken,
      }));
    }
    const values = readMonitorForm(req);
    const fail = (error) => res.status(400).type('html').send(newMonitorPage({
      user: req.user,
      error,
      values,
      demoHint: config.demoEnabled ? `Local sample: ${absoluteDemo(req)}` : '',
      csrf: req.csrfToken,
    }));
    if (!req.user.emailVerifiedAt) return fail('Confirm your email before adding a URL.');
    if (values.selector.includes('<') || values.selector.includes('{') || values.selector.includes('}')) {
      return fail('That CSS selector is not valid.');
    }
    let canonical;
    try {
      canonical = assertPublicHttpUrl(values.url, { allowLocal: config.allowLocalFetch }).toString();
    } catch (err) {
      return fail(err.message);
    }
    const plan = planFor(req.user.plan);
    if (!plan.frequencies.includes(values.frequency)) {
      return fail('Hourly checks are on the Seller and Research plans. Choose daily, or upgrade.');
    }
    if (await db.countMonitors(req.user.id) >= plan.maxMonitors) {
      return fail(`The ${plan.name} plan includes ${plan.maxMonitors} URLs. Remove one or upgrade to add more.`);
    }
    if (await db.findDuplicate(req.user.id, canonical, values.selector, values.mode)) {
      return fail('You are already watching that URL with the same settings.');
    }
    const now = new Date().toISOString();
    const monitor = await db.createMonitor({
      userId: req.user.id,
      url: canonical,
      label: values.label || labelFromUrl(canonical),
      selector: values.selector,
      mode: values.mode,
      frequency: values.frequency,
      createdAt: now,
      nextCheckAt: now,
    });
    res.redirect(303, `/app/monitors/${monitor.id}`);
  }));

  router.get('/monitors/:id', wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    const monitor = await db.findMonitor(Number(req.params.id), req.user.id);
    if (!monitor) return notFound(res, req);
    res.type('html').send(monitorPage({
      user: req.user,
      monitor,
      changes: await db.listChanges(monitor.id),
      snapshot: await db.latestSnapshot(monitor.id),
      config,
      notice: String(req.query.notice || ''),
      error: String(req.query.error || ''),
      csrf: req.csrfToken,
    }));
  }));

  router.post('/monitors/:id/check', wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    const monitor = await db.findMonitor(Number(req.params.id), req.user.id);
    if (!monitor) return notFound(res, req);
    const result = await checkMonitor(ctx, monitor);
    if (result.changeId) return res.redirect(303, `/app/changes/${result.changeId}`);
    const params = new URLSearchParams();
    const notice = noticeFor(result);
    if (notice) params.set('notice', notice);
    if (result.status === 'error' || result.status === 'blocked' || result.status === 'paused') {
      params.set('error', result.error || 'Check failed');
    }
    const suffix = params.toString() ? `?${params}` : '';
    res.redirect(303, `/app/monitors/${monitor.id}${suffix}`);
  }));

  router.post('/monitors/:id/delete', wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    await db.deleteMonitor(Number(req.params.id), req.user.id);
    res.redirect(303, '/app?notice=Monitor+removed');
  }));

  router.get('/changes/:id', wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    const change = await db.findChange(Number(req.params.id), req.user.id);
    if (!change) return notFound(res, req);
    res.type('html').send(changePage({
      user: req.user,
      change,
      before: change.previousSnapshotId ? await db.getSnapshot(change.previousSnapshotId) : null,
      after: await db.getSnapshot(change.snapshotId),
      csrf: req.csrfToken,
    }));
  }));

  router.post('/plan', wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    if (!config.allowPlanSwitch) return res.redirect(303, '/app/settings?error=Plan+changes+are+turned+off');
    const plan = ['free', 'seller', 'research'].includes(req.body?.plan) ? req.body.plan : '';
    if (!plan) return res.redirect(303, '/app/settings?error=Unknown+plan');
    await db.setPlan(req.user.id, plan);
    res.redirect(303, '/app?notice=Plan+updated');
  }));

  router.use((req, res) => notFound(res, req));
  return router;
}

async function sendVerifyEmail(ctx, user) {
  const token = newToken();
  const now = new Date();
  await ctx.db.createEmailToken({
    userId: user.id,
    purpose: 'verify',
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + 24 * HOUR).toISOString(),
    createdAt: now.toISOString(),
  });
  const link = `${ctx.config.appBaseUrl}/app/verify?token=${token}`;
  await ctx.mailer.send({
    to: user.email,
    subject: 'Confirm your Pricewatch email',
    text: `Confirm this address to start watching pages:\n\n${link}\n\nThe link expires in 24 hours.`,
  });
}

async function sendResetEmail(ctx, user) {
  const token = newToken();
  const now = new Date();
  await ctx.db.createEmailToken({
    userId: user.id,
    purpose: 'reset',
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + HOUR).toISOString(),
    createdAt: now.toISOString(),
  });
  const link = `${ctx.config.appBaseUrl}/app/reset?token=${token}`;
  await ctx.mailer.send({
    to: user.email,
    subject: 'Reset your Pricewatch password',
    text: `Set a new password:\n\n${link}\n\nThe link expires in one hour. If you did not ask for this, ignore it.`,
  });
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return '';
  return email;
}

function readMonitorForm(req) {
  return {
    url: String(req.body?.url || '').trim(),
    label: String(req.body?.label || '').trim().slice(0, 120),
    selector: String(req.body?.selector || '').trim().slice(0, 200),
    mode: req.body?.mode === 'price' ? 'price' : 'all',
    frequency: req.body?.frequency === 'hourly' ? 'hourly' : 'daily',
  };
}

function labelFromUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${path}`.slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}

function validPrefill(value, allowLocal) {
  if (!value) return '';
  try {
    return assertPublicHttpUrl(String(value), { allowLocal }).toString();
  } catch {
    return '';
  }
}

function absoluteDemo(req) {
  return `${req.protocol}://${req.get('host')}/demo/page`;
}

function noticeFor(result) {
  if (result.status === 'baseline') return 'Baseline saved. We’ll email you when it changes.';
  if (result.status === 'unchanged') return 'No change since the last check.';
  if (result.status === 'changed') return 'Change detected.';
  return '';
}

function notFound(res, req) {
  res.status(404).type('html').send(page({
    title: 'Not found',
    user: req.user,
    csrf: req.csrfToken,
    width: 640,
    body: '<div class="card"><h1>Page not found</h1><p><a href="/app">Back to your monitors</a></p></div>',
  }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

export { CSRF_COOKIE };
