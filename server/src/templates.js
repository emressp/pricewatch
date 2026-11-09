import { planFor, effectiveFrequency } from './plans.js';

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

const CSS = `
:root {
  --ink: #0b1220; --muted: #5b6b7c; --line: #e6ebf2; --bg: #f6f8fc;
  --card: #fff; --brand: #4f46e5; --brand-dark: #312e81; --teal: #0d9488; --ok: #059669;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; color: var(--ink); background: var(--bg); line-height: 1.55; }
a { color: var(--brand); }
.nav { max-width: 1040px; margin: 0 auto; padding: 18px 20px; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.nav-links { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.logo { font-weight: 800; letter-spacing: -0.02em; font-size: 18px; color: inherit; text-decoration: none; }
.logo span { color: var(--brand); }
.nav a.link { color: var(--muted); text-decoration: none; font-weight: 600; font-size: 14px; }
.btn, button.btn {
  display: inline-block; text-decoration: none; border-radius: 10px; padding: 12px 18px;
  font-weight: 700; font-size: 14px; font-family: inherit; cursor: pointer; border: 0;
}
.btn-primary { background: var(--brand); color: #fff; }
.btn-ghost, button.btn-ghost { background: #fff; color: var(--ink); border: 1px solid var(--line); }
.btn-sm, button.btn-sm {
  text-decoration: none; background: var(--ink); color: #fff; padding: 8px 14px; border-radius: 999px;
  font-size: 13px; font-weight: 600; border: 0; font-family: inherit; cursor: pointer;
}
button.danger { background: #fff; color: #991b1b; border: 1px solid #fecaca; }
.wrap { margin: 0 auto; padding: 8px 20px 56px; }
h1 { font-size: clamp(26px, 4vw, 34px); line-height: 1.15; letter-spacing: -0.03em; margin: 0 0 8px; }
h2 { margin: 0 0 8px; font-size: 20px; letter-spacing: -0.02em; }
.lede, .muted { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 20px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06); margin-bottom: 16px; }
label { display: block; font-size: 13px; font-weight: 700; margin: 12px 0 6px; }
input[type="text"], input[type="email"], input[type="password"], input[type="url"], select, textarea {
  width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); font: inherit; background: #fff; color: var(--ink);
}
fieldset { border: 0; padding: 0; margin: 12px 0; }
legend { font-size: 13px; font-weight: 700; padding: 0; margin-bottom: 6px; }
.choice { font-weight: 500; font-size: 14px; margin: 4px 0; }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; border-radius: 10px; padding: 10px 12px; font-size: 14px; }
.notice { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; border-radius: 10px; padding: 10px 12px; font-size: 14px; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 14px; background: #fff; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 14px; vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 700; }
tr:last-child td { border-bottom: 0; }
.pill { display: inline-block; font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: #eef2ff; color: #312e81; }
.pill.changed { background: #fef3c7; color: #92400e; }
.pill.error, .pill.blocked { background: #fee2e2; color: #991b1b; }
.pill.unchanged, .pill.baseline { background: #d1fae5; color: #065f46; }
.pill.paused { background: #fef3c7; color: #92400e; }
.fine { color: var(--muted); font-size: 12px; margin-top: 28px; }
.diff-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 800px) { .diff-grid { grid-template-columns: 1fr; } }
.snap { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
.col-old { background: #fff7f7; }
.col-new { background: #f3fff8; }
.unified { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.unified .add ins, .unified .del del { text-decoration: none; display: block; padding: 2px 8px; }
.unified .add ins { background: #d1fae5; }
.unified .del del { background: #fee2e2; }
.unified .eq { color: var(--muted); padding: 2px 8px; }
.unified .skip { color: var(--muted); font-style: italic; padding: 8px; }
.user-email { color: var(--muted); font-size: 13px; }
`;

const STATUS_LABEL = {
  pending: 'Waiting',
  baseline: 'Baseline saved',
  unchanged: 'No change',
  changed: 'Change detected',
  error: 'Check failed',
  blocked: 'Blocked by robots.txt',
};

export function formatWhen(iso, now = new Date()) {
  if (!iso) return { rel: 'Not yet', abs: '' };
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return { rel: iso, abs: '' };
  const abs = `${then.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  const seconds = Math.max(0, (now.getTime() - then.getTime()) / 1000);
  let rel = abs;
  if (seconds < 60) rel = 'just now';
  else if (seconds < 3600) rel = `${Math.floor(seconds / 60)} min ago`;
  else if (seconds < 86400) rel = `${Math.floor(seconds / 3600)} hr ago`;
  else rel = `${Math.floor(seconds / 86400)} d ago`;
  return { rel, abs };
}

function statusPill(status) {
  const label = STATUS_LABEL[status] || status || 'Waiting';
  return `<span class="pill ${esc(status)}">${esc(label)}</span>`;
}

function csrfField(token) {
  return `<input type="hidden" name="_csrf" value="${esc(token || '')}" />`;
}

export function page({ title, user, body, width = 1040, csrf = '' }) {
  const navRight = user
    ? `<a class="link" href="/app/settings">Settings</a><span class="user-email">${esc(user.email)}</span>
       <form method="post" action="/app/logout" style="margin:0">${csrfField(csrf)}<button class="btn-sm" type="submit">Log out</button></form>`
    : `<a class="link" href="/app/login">Log in</a><a class="btn-sm" href="/app/signup">Start free</a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} — Pricewatch</title>
  <meta name="robots" content="noindex" />
  <style>${CSS}</style>
</head>
<body>
  <nav class="nav">
    <a class="logo" href="/">Price<span>watch</span></a>
    <div class="nav-links">
      <a class="link" href="/monitor/">Change Monitor</a>
      ${navRight}
    </div>
  </nav>
  <main class="wrap" style="max-width:${width}px">${body}</main>
  <footer class="fine" style="max-width:${width}px;margin:0 auto;padding:0 20px 32px"><a href="/terms/">Terms</a> · <a href="/privacy/">Privacy</a> · <a href="/app/settings">Alert settings</a></footer>
</body>
</html>`;
}

function banner(error, notice) {
  return `${error ? `<p class="error">${esc(error)}</p>` : ''}${notice ? `<p class="notice">${esc(notice)}</p>` : ''}`;
}

export function signupPage({ error = '', email = '', csrf = '' } = {}) {
  return page({
    title: 'Create your account',
    csrf,
    width: 520,
    body: `<h1>Watch a page for free.</h1>
      <p class="lede">The Watch plan covers 3 URLs, checked daily. You’ll get an email when prices, products, or the page details change.</p>
      <div class="card">
        ${banner(error)}
        <form method="post" action="/app/signup">
          ${csrfField(csrf)}
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}" />
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required />
          <p class="muted" style="font-size:13px">At least 8 characters.</p>
          <button class="btn btn-primary" type="submit">Create free account</button>
        </form>
      </div>
      <p class="muted">Already have an account? <a href="/app/login">Log in</a></p>`,
  });
}

export function loginPage({ error = '', email = '', notice = '', csrf = '' } = {}) {
  return page({
    title: 'Log in',
    csrf,
    width: 520,
    body: `<h1>Log in</h1>
      <p class="lede">Open your Change Monitor watchlist.</p>
      <div class="card">
        ${banner(error, notice)}
        <form method="post" action="/app/login">
          ${csrfField(csrf)}
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}" />
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
          <button class="btn btn-primary" type="submit">Log in</button>
        </form>
      </div>
      <p class="muted">New here? <a href="/app/signup">Create a free account</a> · <a href="/app/forgot">Forgot password</a></p>`,
  });
}

export function dashboardPage({ user, monitors, config, notice = '', error = '', demoUrl = '', csrf = '' }) {
  const plan = planFor(user.plan);
  const rows = monitors.map((monitor) => {
    const when = formatWhen(monitor.lastCheckedAt);
    return `<tr>
      <td><a href="/app/monitors/${monitor.id}">${esc(monitor.label || monitor.url)}</a><div class="muted" style="font-size:12px">${esc(monitor.url)}</div></td>
      <td>${monitor.mode === 'price' ? 'Price only' : 'Whole page'}${monitor.selector ? `<div class="muted" style="font-size:12px">${esc(monitor.selector)}</div>` : ''}</td>
      <td>${esc(frequencyLabel(user.plan, monitor.frequency))}</td>
      <td title="${esc(when.abs)}">${esc(when.rel)}</td>
      <td>${statusPill(monitor.lastStatus)}${monitor.lastError ? `<div class="muted" style="font-size:12px;margin-top:4px">${esc(monitor.lastError)}</div>` : ''}</td>
    </tr>`;
  }).join('');
  const empty = `<div class="card"><h2>No URLs yet</h2><p class="muted">Add a public product, pricing, or catalog page. The first check saves a baseline and does not send an email.</p></div>`;
  const table = `<div class="table-wrap"><table>
      <thead><tr><th>Page</th><th>Mode</th><th>Frequency</th><th>Last checked</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  const demo = config.demoEnabled && demoUrl ? `<div class="card">
      <h2>Sample store</h2>
      <p class="muted">A local page you can change without leaving this machine. Watch it, run a check, then simulate a price change and check again.</p>
      <div class="row">
        <a class="btn btn-primary" href="/app/monitors/new?url=${encodeURIComponent(demoUrl)}&amp;mode=price&amp;label=Northwind%20sample">Watch the sample store</a>
        <a class="btn btn-ghost" href="/demo/page">View the sample</a>
      </div>
    </div>` : '';
  const upgrade = config.allowPlanSwitch ? `<div class="card">
      <h2>Plan</h2>
      <p class="muted">Switching plans here is for local development. In production, set the plan from your biller. See the README.</p>
      <form method="post" action="/app/plan" class="row">
        ${csrfField(csrf)}
        <select name="plan" aria-label="Plan" style="width:auto;min-width:240px">
          ${Object.values({ free: planFor('free'), seller: planFor('seller'), research: planFor('research') }).map((item) =>
            `<option value="${item.id}"${item.id === user.plan ? ' selected' : ''}>${esc(item.name)} · ${esc(item.price)} · ${item.maxMonitors} URLs</option>`).join('')}
        </select>
        <button class="btn btn-ghost" type="submit">Switch plan</button>
      </form>
    </div>` : `<p class="muted"><a href="/app/settings">Seller ($19/mo) and Research ($49/mo)</a> are billed with Polar in the existing Pricewatch organization.</p>`;
  const verify = user.emailVerifiedAt ? '' : `<div class="card"><h2>Confirm your email</h2><p class="muted">We sent a link to ${esc(user.email)}. You can add URLs after you open it.</p><form method="post" action="/app/verify/resend">${csrfField(csrf)}<button class="btn btn-ghost" type="submit">Resend confirmation</button></form></div>`;
  return page({
    title: 'Your monitors',
    user,
    csrf,
    body: `<div class="row" style="justify-content:space-between;align-items:flex-end">
        <div>
          <h1>Your monitors</h1>
          <p class="lede" style="margin-top:0">${esc(plan.name)} plan · ${monitors.length} / ${plan.maxMonitors} URLs · ${plan.frequencies.includes('hourly') ? 'hourly or daily checks' : 'daily checks'}</p>
        </div>
        <a class="btn btn-primary" href="/app/monitors/new">Add a URL</a>
      </div>
      ${banner(error, notice)}
      ${verify}
      ${monitors.length ? table : empty}
      ${demo}
      ${upgrade}`,
  });
}

function frequencyLabel(planId, frequency) {
  const effective = effectiveFrequency(planId, frequency);
  if (effective !== frequency) return 'Daily (plan limit)';
  return frequency === 'hourly' ? 'Hourly' : 'Daily';
}

export function newMonitorPage({ user, error = '', values = {}, demoHint = '', csrf = '' }) {
  const plan = planFor(user.plan);
  const hourlyOk = plan.frequencies.includes('hourly');
  const mode = values.mode === 'price' ? 'price' : 'all';
  const frequency = values.frequency === 'hourly' ? 'hourly' : 'daily';
  return page({
    title: 'Add a URL',
    user,
    csrf,
    width: 720,
    body: `<h1>Add a URL</h1>
      <p class="lede">Public http(s) pages only. ${esc(plan.name)} includes ${plan.maxMonitors} URLs.</p>
      <div class="card">
        ${banner(error)}
        <form method="post" action="/app/monitors">
          ${csrfField(csrf)}
          <label for="url">Website URL</label>
          <input id="url" name="url" type="url" required placeholder="https://example.com/pricing" value="${esc(values.url || '')}" />
          <label for="label">Label <span class="muted" style="font-weight:500">(optional)</span></label>
          <input id="label" name="label" type="text" maxlength="120" value="${esc(values.label || '')}" />
          <fieldset>
            <legend>What to compare</legend>
            <label class="choice"><input type="radio" name="mode" value="all"${mode === 'all' ? ' checked' : ''} /> Whole page — prices, products, and other visible information</label>
            <label class="choice"><input type="radio" name="mode" value="price"${mode === 'price' ? ' checked' : ''} /> Price only — alert when prices or priced products change</label>
          </fieldset>
          <label for="selector">CSS selector <span class="muted" style="font-weight:500">(optional)</span></label>
          <input id="selector" name="selector" type="text" maxlength="200" placeholder=".pricing or #plans" value="${esc(values.selector || '')}" />
          <p class="muted" style="font-size:13px">Leave this blank to watch the whole page. A selector limits the check to one part of the page.</p>
          <fieldset>
            <legend>Check frequency</legend>
            <label class="choice"><input type="radio" name="frequency" value="daily"${frequency !== 'hourly' ? ' checked' : ''} /> Daily</label>
            <label class="choice"><input type="radio" name="frequency" value="hourly"${frequency === 'hourly' ? ' checked' : ''}${hourlyOk ? '' : ' disabled'} /> Hourly${hourlyOk ? '' : ' — Seller and Research plans'}</label>
          </fieldset>
          <div class="row">
            <button class="btn btn-primary" type="submit">Save monitor</button>
            <a class="btn btn-ghost" href="/app">Cancel</a>
          </div>
        </form>
        ${demoHint ? `<p class="muted">${demoHint}</p>` : ''}
      </div>`,
  });
}

export function monitorPage({ user, monitor, changes, snapshot, config, notice = '', error = '', csrf = '' }) {
  const when = formatWhen(monitor.lastCheckedAt);
  const preview = snapshot?.text ? cap(snapshot.text, 40) : null;
  const history = changes.length ? `<div class="table-wrap"><table>
      <thead><tr><th>When</th><th>What changed</th><th></th></tr></thead>
      <tbody>${changes.map((change) => {
        const at = formatWhen(change.createdAt);
        return `<tr>
          <td title="${esc(at.abs)}">${esc(at.rel)}</td>
          <td>${esc(change.summary)}</td>
          <td><a href="/app/changes/${change.id}">View diff</a></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>` : `<p class="muted">No changes yet. The first check saves a baseline and does not send an email.</p>`;
  const demo = config.demoEnabled && monitor.url.includes('/demo/page') ? `<div class="card">
      <h2>Sample controls</h2>
      <p class="muted">These buttons only exist while the demo sample is enabled. They edit the local sample store, not a customer site.</p>
      <div class="row">
        <form method="post" action="/demo/variant">
          ${csrfField(csrf)}
          <input type="hidden" name="variant" value="changed" />
          <input type="hidden" name="next" value="/app/monitors/${monitor.id}" />
          <button class="btn btn-ghost" type="submit">Simulate a price change</button>
        </form>
        <form method="post" action="/demo/variant">
          ${csrfField(csrf)}
          <input type="hidden" name="variant" value="original" />
          <input type="hidden" name="next" value="/app/monitors/${monitor.id}" />
          <button class="btn btn-ghost" type="submit">Reset sample prices</button>
        </form>
      </div>
    </div>` : '';
  return page({
    title: monitor.label || 'Monitor',
    user,
    csrf,
    body: `<p class="muted" style="margin-bottom:6px"><a href="/app">All monitors</a></p>
      <h1>${esc(monitor.label || hostOf(monitor.url))}</h1>
      <p class="lede"><a href="${esc(monitor.url)}">${esc(monitor.url)}</a></p>
      ${banner(error, notice)}
      <div class="card">
        <p style="margin-top:0">${statusPill(monitor.lastStatus)}
          <span class="muted"> · ${monitor.mode === 'price' ? 'Price only' : 'Whole page'}
          · ${esc(frequencyLabel(user.plan, monitor.frequency))}
          · Last checked <span title="${esc(when.abs)}">${esc(when.rel)}</span></span>
        </p>
        ${monitor.selector ? `<p class="muted">Selector: <code>${esc(monitor.selector)}</code></p>` : ''}
        ${monitor.lastError ? `<p class="error">${esc(monitor.lastError)}</p>` : ''}
        <div class="row">
          <form method="post" action="/app/monitors/${monitor.id}/check">${csrfField(csrf)}<button class="btn btn-primary" type="submit">Check now</button></form>
          <form method="post" action="/app/monitors/${monitor.id}/delete" onsubmit="return confirm('Remove this monitor?');">${csrfField(csrf)}<button class="btn danger" type="submit">Remove</button></form>
        </div>
      </div>
      ${demo}
      <h2>Latest snapshot</h2>
      <div class="card col-new">${preview ? `<pre class="snap">${esc(preview.text)}</pre>${preview.extra ? `<p class="muted">${preview.extra} more lines stored.</p>` : ''}` : '<p class="muted" style="margin:0">No snapshot yet. Run a check to save a baseline.</p>'}</div>
      <h2>Change history</h2>
      ${history}`,
  });
}

export function changePage({ user, change, before, after, csrf = '' }) {
  const previous = cap(before?.text || '', 300);
  const current = cap(after?.text || '', 300);
  const prices = (change.diff?.priceChanges || []).map((item) => `<li>${esc(describe(item))}</li>`).join('');
  const unified = (change.diff?.lines || []).map((line) => {
    if (line.op === 'skip') return `<div class="skip">${esc(line.text)}</div>`;
    if (line.op === 'add') return `<div class="add"><ins>+ ${esc(line.text)}</ins></div>`;
    if (line.op === 'del') return `<div class="del"><del>- ${esc(line.text)}</del></div>`;
    return `<div class="eq">  ${esc(line.text)}</div>`;
  }).join('');
  const when = formatWhen(change.createdAt);
  const mailed = user.alertsEnabled === false
    ? 'Alerts are off, so no email was sent. You can turn them back on in alert settings.'
    : change.alertedAt
      ? `Alert email sent to ${esc(user.email)} at ${esc(formatWhen(change.alertedAt).abs)}.`
      : 'The change is saved. The alert email has not gone out yet.';
  return page({
    title: 'Change',
    user,
    csrf,
    body: `<p class="muted" style="margin-bottom:6px"><a href="/app/monitors/${change.monitorId}">Back to monitor</a></p>
      <h1>${esc(change.summary)}</h1>
      <p class="lede">${esc(change.label || change.url)} · <span title="${esc(when.abs)}">${esc(when.rel)}</span></p>
      <p class="muted">${mailed}</p>
      ${prices ? `<div class="card"><h2>Prices and products</h2><ul>${prices}</ul></div>` : ''}
      <h2>Old vs new</h2>
      <div class="diff-grid">
        <div class="card col-old"><h2>Previous</h2><pre class="snap">${esc(previous.text || '—')}</pre>${previous.extra ? `<p class="muted">${previous.extra} more lines not shown.</p>` : ''}</div>
        <div class="card col-new"><h2>Current</h2><pre class="snap">${esc(current.text || '—')}</pre>${current.extra ? `<p class="muted">${current.extra} more lines not shown.</p>` : ''}</div>
      </div>
      ${unified ? `<h2>Line diff</h2><div class="card unified">${unified}</div>` : ''}`,
  });
}

function describe(change) {
  if (change.type === 'changed') return `${change.label}: ${change.from} → ${change.to}`;
  if (change.type === 'added') return `Added ${change.label} (${change.to})`;
  return `Removed ${change.label} (${change.from})`;
}

function cap(text, maxLines) {
  const lines = String(text || '').split('\n');
  if (lines.length <= maxLines) return { text: lines.join('\n'), extra: 0 };
  return { text: lines.slice(0, maxLines).join('\n'), extra: lines.length - maxLines };
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

export function forgotPage({ csrf = '', notice = '', error = '' } = {}) {
  return page({
    title: 'Reset password',
    csrf,
    width: 520,
    body: `<h1>Reset your password</h1>
      <div class="card">
        ${banner(error, notice)}
        <form method="post" action="/app/forgot">
          ${csrfField(csrf)}
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" required />
          <button class="btn btn-primary" type="submit">Send reset link</button>
        </form>
      </div>
      <p class="muted"><a href="/app/login">Back to log in</a></p>`,
  });
}

export function resetPage({ token = '', csrf = '', error = '' } = {}) {
  return page({
    title: 'Choose a password',
    csrf,
    width: 520,
    body: `<h1>Choose a new password</h1>
      <div class="card">
        ${banner(error)}
        <form method="post" action="/app/reset">
          ${csrfField(csrf)}
          <input type="hidden" name="token" value="${esc(token)}" />
          <label for="password">New password</label>
          <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required />
          <button class="btn btn-primary" type="submit">Update password</button>
        </form>
      </div>`,
  });
}

export function settingsPage({ user, config, csrf = '', notice = '', error = '' }) {
  const plan = planFor(user.plan);
  const billingReady = Boolean(config.polarAccessToken && (config.polarSellerProductId || config.polarResearchProductId));
  const checkout = billingReady ? `<div class="row">
      <form method="post" action="/app/billing/checkout">${csrfField(csrf)}<input type="hidden" name="plan" value="seller" /><button class="btn btn-primary" type="submit">Seller · $19/mo</button></form>
      <form method="post" action="/app/billing/checkout">${csrfField(csrf)}<input type="hidden" name="plan" value="research" /><button class="btn btn-ghost" type="submit">Research · $49/mo</button></form>
      <form method="post" action="/app/billing/portal">${csrfField(csrf)}<button class="btn btn-ghost" type="submit">Manage or cancel in Polar</button></form>
    </div>` : `<p class="muted">Polar checkout is not configured on this server yet. Set the product ids from the existing Pricewatch Polar organization.</p>`;
  return page({
    title: 'Settings',
    user,
    csrf,
    width: 720,
    body: `<h1>Settings</h1>
      ${banner(error, notice)}
      <div class="card">
        <h2>Plan</h2>
        <p class="muted">${esc(plan.name)} · ${esc(plan.price)} · ${plan.maxMonitors} URLs · ${plan.frequencies.includes('hourly') ? 'hourly or daily' : 'daily'} checks</p>
        ${checkout}
      </div>
      <div class="card">
        <h2>Alerts</h2>
        <form method="post" action="/app/settings/alerts">
          ${csrfField(csrf)}
          <label class="choice"><input type="checkbox" name="alerts" value="1"${user.alertsEnabled ? ' checked' : ''} /> Email me when a watched page changes</label>
          <button class="btn btn-primary" type="submit">Save</button>
        </form>
      </div>
      <div class="card">
        <h2>Delete account</h2>
        <p class="muted">This removes your login, monitors, and change history from this server.</p>
        <form method="post" action="/app/account/delete" onsubmit="return confirm('Delete this account?');">
          ${csrfField(csrf)}
          <button class="btn danger" type="submit">Delete account</button>
        </form>
      </div>`,
  });
}
