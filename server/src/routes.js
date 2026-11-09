import express from 'express';
import {
  SESSION_COOKIE, SESSION_MS, clearSessionCookie, hashPassword, newSessionToken,
  readCookie, sessionCookie, verifyPassword,
} from './auth.js';
import { checkMonitor } from './checker.js';
import { assertPublicHttpUrl } from './net.js';
import { planFor } from './plans.js';
import {
  changePage, dashboardPage, loginPage, monitorPage, newMonitorPage, page, signupPage,
} from './templates.js';

export function safeNext(value) {
  if (typeof value !== 'string') return '/app';
  if (value !== '/app' && !value.startsWith('/app/')) return '/app';
  if (value.includes('\\') || value.includes('://')) return '/app';
  return value;
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function wantsJson(req) {
  return String(req.headers.accept || '').includes('application/json');
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
    if (!token) return next();
    const session = db.findSession(token);
    const now = new Date().toISOString();
    if (!session || session.expiresAt <= now) {
      if (session) db.deleteSession(token);
      return next();
    }
    req.user = db.findUserById(session.userId);
    req.sessionToken = token;
    return next();
  }));

  function secure(req) {
    return Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https');
  }

  function startSession(res, req, user) {
    const token = newSessionToken();
    const expires = new Date(Date.now() + SESSION_MS).toISOString();
    db.createSession({ token, userId: user.id, expiresAt: expires });
    res.set('Set-Cookie', sessionCookie(token, { secure: secure(req) }));
  }

  router.get('/', (req, res) => {
    if (!req.user) return res.redirect(302, '/app/signup');
    const monitors = db.listMonitors(req.user.id);
    res.type('html').send(dashboardPage({
      user: req.user,
      monitors,
      config,
      notice: req.query.notice || '',
      error: req.query.error || '',
      demoUrl: absoluteDemo(req),
    }));
  });

  router.get('/signup', (req, res) => {
    if (req.user) return res.redirect(302, '/app');
    res.type('html').send(signupPage());
  });

  router.post('/signup', wrap(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email || password.length < 8 || password.length > 200) {
      return res.status(400).type('html').send(signupPage({
        error: 'Enter an email and a password of at least 8 characters.',
        email,
      }));
    }
    const user = db.createUser({
      email,
      passwordHash: await hashPassword(password),
      createdAt: new Date().toISOString(),
    });
    if (!user) {
      return res.status(400).type('html').send(signupPage({
        error: 'That email already has an account. Log in instead.',
        email,
      }));
    }
    startSession(res, req, user);
    res.redirect(303, '/app');
  }));

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(302, '/app');
    res.type('html').send(loginPage());
  });

  router.post('/login', wrap(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const user = email ? db.findUserByEmail(email) : null;
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!ok) {
      return res.status(400).type('html').send(loginPage({
        error: 'Email or password is not right.',
        email,
      }));
    }
    startSession(res, req, user);
    res.redirect(303, '/app');
  }));

  router.post('/logout', (req, res) => {
    if (req.sessionToken) db.deleteSession(req.sessionToken);
    res.set('Set-Cookie', clearSessionCookie());
    res.redirect(303, '/app/login');
  });

  router.get('/monitors/new', (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    const url = validPrefill(req.query.url, config.allowLocalFetch);
    const label = String(req.query.label || '').replace(/[<>]/g, '').trim().slice(0, 120);
    res.type('html').send(newMonitorPage({
      user: req.user,
      values: { url, label, mode: req.query.mode === 'price' ? 'price' : 'all', frequency: 'daily' },
      demoHint: config.demoEnabled ? `Local sample: ${absoluteDemo(req)}` : '',
    }));
  });

  router.post('/monitors', (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    const values = {
      url: String(req.body?.url || '').trim(),
      label: String(req.body?.label || '').trim().slice(0, 120),
      selector: String(req.body?.selector || '').trim().slice(0, 200),
      mode: req.body?.mode === 'price' ? 'price' : 'all',
      frequency: req.body?.frequency === 'hourly' ? 'hourly' : 'daily',
    };
    const fail = (error) => res.status(400).type('html').send(newMonitorPage({
      user: req.user,
      error,
      values,
      demoHint: config.demoEnabled ? `Local sample: ${absoluteDemo(req)}` : '',
    }));
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
    if (db.countMonitors(req.user.id) >= plan.maxMonitors) {
      return fail(`The ${plan.name} plan includes ${plan.maxMonitors} URLs. Remove one or upgrade to add more.`);
    }
    if (db.findDuplicate(req.user.id, canonical, values.selector, values.mode)) {
      return fail('You are already watching that URL with the same settings.');
    }
    const now = new Date().toISOString();
    const monitor = db.createMonitor({
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
  });

  router.get('/monitors/:id', (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    const monitor = db.findMonitor(Number(req.params.id), req.user.id);
    if (!monitor) return notFound(res, req.user);
    res.type('html').send(monitorPage({
      user: req.user,
      monitor,
      changes: db.listChanges(monitor.id),
      snapshot: db.latestSnapshot(monitor.id),
      config,
      notice: String(req.query.notice || ''),
      error: String(req.query.error || ''),
    }));
  });

  router.post('/monitors/:id/check', wrap(async (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    const monitor = db.findMonitor(Number(req.params.id), req.user.id);
    if (!monitor) return notFound(res, req.user);
    const result = await checkMonitor(ctx, monitor);
    const notice = noticeFor(result);
    const error = result.status === 'error' || result.status === 'blocked' ? result.error : '';
    const params = new URLSearchParams();
    if (notice) params.set('notice', notice);
    if (error) params.set('error', error);
    const suffix = params.toString() ? `?${params}` : '';
    if (result.changeId && !wantsJson(req)) return res.redirect(303, `/app/changes/${result.changeId}`);
    res.redirect(303, `/app/monitors/${monitor.id}${suffix}`);
  }));

  router.post('/monitors/:id/delete', (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    db.deleteMonitor(Number(req.params.id), req.user.id);
    res.redirect(303, '/app?notice=Monitor+removed');
  });

  router.get('/changes/:id', (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    const change = db.findChange(Number(req.params.id), req.user.id);
    if (!change) return notFound(res, req.user);
    res.type('html').send(changePage({
      user: req.user,
      change,
      before: change.previousSnapshotId ? db.getSnapshot(change.previousSnapshotId) : null,
      after: db.getSnapshot(change.snapshotId),
    }));
  });

  router.post('/plan', (req, res) => {
    if (!req.user) return res.redirect(302, '/app/login');
    if (!config.allowPlanSwitch) return res.redirect(303, '/app?error=Plan+changes+are+turned+off');
    const plan = ['free', 'seller', 'research'].includes(req.body?.plan) ? req.body.plan : '';
    if (!plan) return res.redirect(303, '/app?error=Unknown+plan');
    db.setPlan(req.user.id, plan);
    res.redirect(303, '/app?notice=Plan+updated');
  });

  router.use((req, res) => notFound(res, req.user));
  return router;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return '';
  return email;
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

function notFound(res, user) {
  res.status(404).type('html').send(page({
    title: 'Not found',
    user,
    width: 640,
    body: '<div class="card"><h1>Page not found</h1><p><a href="/app">Back to your monitors</a></p></div>',
  }));
}
