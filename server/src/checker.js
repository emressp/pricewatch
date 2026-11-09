import { extractContent } from './extract.js';
import { buildChange, renderEmail } from './diff.js';
import { effectiveFrequency, intervalMs, monitorsWithinPlan, planFor } from './plans.js';
import { signAlertToken } from './tokens.js';
import { assertPublicHttpUrl, assertResolvedHost, fetchPage, fetchRobotsTxt } from './net.js';
import { robotsDecision } from './robots.js';

export async function catchUpDueMonitors(ctx, { maxPasses = 8 } = {}) {
  const results = [];
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const batch = await checkDueMonitors(ctx);
    results.push(...batch);
    if (!batch.length) break;
  }
  return results;
}

export async function checkDueMonitors(ctx, now = new Date()) {
  await deliverPendingAlerts(ctx);
  const due = await ctx.db.listDue(now.toISOString(), 25);
  const results = [];
  for (const monitor of due) results.push(await checkMonitor(ctx, monitor, { now }));
  return results;
}

export async function checkMonitor(ctx, monitor, opts = {}) {
  if (!monitor) return { status: 'missing' };
  const inflight = ctx.inflight || (ctx.inflight = new Set());
  if (inflight.has(monitor.id)) return { id: monitor.id, status: 'skipped' };
  inflight.add(monitor.id);
  try {
    return await runCheck(ctx, monitor, opts.now || new Date());
  } finally {
    inflight.delete(monitor.id);
  }
}

async function runCheck(ctx, monitor, now) {
  const checkedAt = now.toISOString();
  const frequency = effectiveFrequency(monitor.userPlan || 'free', monitor.frequency);
  const nextCheckAt = new Date(now.getTime() + intervalMs(frequency)).toISOString();
  const fail = async (status, error) => {
    await ctx.db.finishCheck(monitor.id, { status, error, nextCheckAt, checkedAt });
    return { id: monitor.id, status, error };
  };

  const allowed = monitorsWithinPlan(await ctx.db.listMonitors(monitor.userId), planFor(monitor.userPlan).maxMonitors);
  if (!allowed.has(monitor.id)) {
    return await fail('paused', 'This URL is over your plan limit. Remove one or upgrade.');
  }

  let url;
  try {
    url = assertPublicHttpUrl(monitor.url, { allowLocal: ctx.config.allowLocalFetch });
    await assertResolvedHost(url, { allowLocal: ctx.config.allowLocalFetch, lookup: ctx.lookup });
  } catch (err) {
    return await fail('error', err.message);
  }

  let robots;
  try {
    robots = await loadRobots(ctx, url);
  } catch (err) {
    return await fail('error', err.message);
  }
  const decision = robotsDecision(robots.body, `${url.pathname}${url.search}`, ctx.config.userAgent);
  if (!decision.allowed) {
    return await fail('blocked', `Blocked by robots.txt for ${url.pathname || '/'}.`);
  }

  await ctx.limiter.wait(url.host, (decision.crawlDelaySec || 0) * 1000);

  let page;
  try {
    page = await fetchPage(url, {
      fetchImpl: ctx.fetchImpl,
      userAgent: ctx.config.userAgent,
      timeoutMs: ctx.config.fetchTimeoutMs,
      maxBytes: ctx.config.fetchMaxBytes,
      allowLocal: ctx.config.allowLocalFetch,
      lookup: ctx.lookup,
    });
  } catch (err) {
    return await fail('error', err.message);
  }

  const extracted = extractContent(page.html, { selector: monitor.selector, mode: monitor.mode });
  if (!extracted.ok) return await fail('error', extracted.error);

  const previous = await ctx.db.latestSnapshot(monitor.id);
  const diff = previous && previous.contentHash !== extracted.hash ? buildChange(previous, extracted) : null;
  const status = !previous ? 'baseline' : diff ? 'changed' : 'unchanged';
  const note = extracted.mode === 'price' && extracted.prices.length === 0 ? 'No prices found on the page.' : '';
  const recorded = await ctx.db.recordCheck({
    monitorId: monitor.id,
    snapshot: {
      checkedAt,
      contentHash: extracted.hash,
      text: extracted.text,
      prices: extracted.prices,
      httpStatus: page.status,
    },
    change: diff ? { previousSnapshotId: previous.id, summary: diff.summary, diff } : null,
    finish: { status, error: note, nextCheckAt, checkedAt, contentHash: extracted.hash },
  });

  if (recorded.changeId) await sendAlert(ctx, monitor, recorded.changeId, diff);
  return { id: monitor.id, status, summary: diff?.summary || '', changeId: recorded.changeId || null };
}

async function loadRobots(ctx, url) {
  const cached = await ctx.db.getRobots(url.origin);
  if (cached) {
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    const ttl = cached.status >= 500 ? 10 * 60 * 1000 : 12 * 60 * 60 * 1000;
    if (age >= 0 && age < ttl) return cached;
  }
  const result = await fetchRobotsTxt(new URL('/robots.txt', url.origin), {
    fetchImpl: ctx.fetchImpl,
    userAgent: ctx.config.userAgent,
    timeoutMs: ctx.config.robotsTimeoutMs,
  });
  let body = result.body || '';
  if (result.status >= 500) throw new Error(`Could not read robots.txt (HTTP ${result.status}).`);
  if (result.status === 404) body = '';
  else if (result.status >= 400) body = 'User-agent: *\nDisallow: /\n';
  const row = { origin: url.origin, body, status: result.status, fetchedAt: new Date().toISOString() };
  await ctx.db.putRobots(row);
  return row;
}

function alertLinks(ctx, monitor) {
  const base = ctx.config.appBaseUrl;
  const token = signAlertToken({ id: monitor.userId, email: monitor.userEmail }, ctx.config.sessionSecret);
  return {
    changeUrl: `${base}/app/changes/${monitor.changeId || ''}`,
    manageUrl: `${base}/app/settings`,
    unsubscribeUrl: `${base}/app/unsubscribe?token=${encodeURIComponent(token)}`,
  };
}

async function deliverChangeEmail(ctx, { to, monitor, diff, changeId }) {
  if (!await ctx.db.claimAlert(changeId)) return;
  if (monitor.alertsEnabled === false || monitor.alertsEnabled === 0) {
    await ctx.db.markAlerted(changeId, new Date().toISOString());
    return;
  }
  try {
    const links = alertLinks(ctx, { ...monitor, changeId });
    const email = renderEmail({
      monitor,
      diff,
      changeUrl: `${ctx.config.appBaseUrl}/app/changes/${changeId}`,
      manageUrl: links.manageUrl,
      unsubscribeUrl: links.unsubscribeUrl,
    });
    const sent = await ctx.mailer.send({ to, subject: email.subject, text: email.text });
    if (sent?.skipped) {
      await ctx.db.releaseAlert(changeId);
      console.log(`[pricewatch mail] daily limit reached; kept alert ${changeId} for later`);
      return;
    }
    await ctx.db.markAlerted(changeId, new Date().toISOString());
    if (monitor.id) await ctx.db.clearError(monitor.id);
  } catch (err) {
    await ctx.db.releaseAlert(changeId);
    if (monitor.id) await ctx.db.setMonitorError(monitor.id, `Change saved. Email failed: ${err.message}`);
    else console.error(`[checker] alert failed for change ${changeId}: ${err.message}`);
  }
}

async function sendAlert(ctx, monitor, changeId, diff) {
  await deliverChangeEmail(ctx, { to: monitor.userEmail, monitor, diff, changeId });
}

export async function deliverPendingAlerts(ctx) {
  for (const change of await ctx.db.listUnalerted(20)) {
    if (!change.userEmail) continue;
    await deliverChangeEmail(ctx, {
      to: change.userEmail,
      monitor: {
        id: change.monitorId,
        userId: change.userId,
        userEmail: change.userEmail,
        url: change.url,
        label: change.label,
        alertsEnabled: change.alertsEnabled,
      },
      diff: change.diff,
      changeId: change.id,
    });
  }
}
