# Pricewatch

Weekly SaaS pricing intel, plus a **Website Change Monitor** for any public page.

Pricewatch is one product. The weekly brief watches a curated set of SaaS pricing pages. Change Monitor is the upgrade for online sellers, competitor researchers, and operators who want an alert when a specific URL’s prices, products, or other information change.

- Live marketing site: https://emressp.github.io/pricewatch/
- Change Monitor plans: https://emressp.github.io/pricewatch/monitor/
- Free sample brief: [HTML](sample/weekly-intel.html) · [PDF](sample/weekly-intel.pdf)

The weekly-intel pages are static and can stay on GitHub Pages. Change Monitor needs the small Node service in `server/` because it has accounts, a database, a scheduler, and email.

## Website Change Monitor

A customer signs up, adds a public URL, and optionally:

- limits the check to a CSS selector
- switches to price-only mode (ignore copy that is not a price or priced product)
- chooses daily checks, or hourly checks on a paid plan

The scheduler fetches the page, strips cookie banners, ad slots, timestamps, and session tokens, stores a snapshot, and emails a readable old-vs-new diff when the meaningful text changes. The first check is a baseline and does not send mail. Fetches honor `robots.txt` and wait between requests to the same host. Private and link-local addresses are refused. Loopback is allowed only when `ALLOW_LOCAL_FETCH=1`, so the local sample store works.

| Plan | Price | URLs | Schedule |
| --- | --- | --- | --- |
| Watch | Free | 3 | Daily |
| Seller | $19/mo | 25 | Hourly or daily |
| Research | $49/mo | 100 | Hourly or daily |

Signup always starts on Watch. Billing is not included; see [Deploying](#deploying).

### Architecture

```
Browser
  ├─ static pages (index, /monitor, /pricing)  — GitHub Pages, or this process
  └─ /app  accounts, monitors, history, diffs  — this process
        │
        ▼
Node 22  (Express, no native addons)
  ├─ SQLite file          users, sessions, monitors, snapshots, changes
  ├─ scheduler            due checks inside the process, or `npm run check` from cron
  ├─ fetcher              robots.txt, per-host delay, size and timeout caps
  ├─ extract + diff       noise filter, price/product changes, line diff
  └─ mail                 SMTP when configured, otherwise console + outbox files
```

Stack choice: one Node process and a SQLite file. No Redis, no separate worker service, and no compiled database driver (`node:sqlite`, which ships with Node 22). That is enough for a small watchlist and is cheap to run on Fly.io, Render, Railway, or a $5 VPS with a persistent disk.

## Running locally

Requires Node.js 22.13 or newer.

```bash
cd server
cp .env.example .env
npm install
npm start
```

From the repo root, `npm start`, `npm test`, `npm run demo`, and `npm run check` do the same thing.

Then open:

- http://localhost:8787/ — marketing site, including the Change Monitor section
- http://localhost:8787/monitor/ — plans
- http://localhost:8787/app/signup — free account
- http://localhost:8787/demo/page — sample store the checker can watch

Try the loop on one machine:

1. Create an account and choose **Watch the sample store** (price-only).
2. Open the monitor and click **Check now**. The status becomes “Baseline saved” and no email is sent.
3. Click **Simulate a price change**, then **Check now** again.
4. The change page shows the previous and current text. The alert is printed in the server log and written to `server/data/outbox/` until you set `SMTP_HOST`.

`npm test` covers extraction, price and copy diffs, robots.txt rules, host blocking, and that same loop over HTTP. `npm run demo` runs the loop once and prints the email.

`npm run check` runs a single scheduler pass and exits. Use it from cron if you set `CHECKER_ENABLED=0` on the web process.

## Deploying

GitHub Pages will keep serving the static marketing site. It will not run checks or send mail. You need three things:

1. **A host for the Node process.** Fly.io, Render, Railway, or a small VPS. One web process is enough: it serves `/app` and can also serve this repo as the marketing site. Put the service behind HTTPS and set `TRUST_PROXY=1` when a proxy terminates TLS.
2. **A database on a persistent disk.** The database is a SQLite file at `DATABASE_PATH`. The schema is created on startup. An ephemeral container disk will wipe accounts on restart — attach a volume and point `DATABASE_PATH` at it (for example `/data/pricewatch.sqlite`).
3. **An email provider.** Postmark, Resend, Amazon SES, or any other SMTP host. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and a verified `MAIL_FROM`. With `SMTP_HOST` empty, mail is written to the log and to `OUTBOX_DIR` instead.

```bash
docker build -t pricewatch .
docker run --rm -p 8787:8787 \
  -v pwdata:/data \
  -e NODE_ENV=production \
  -e PORT=8787 \
  -e DATABASE_PATH=/data/pricewatch.sqlite \
  -e OUTBOX_DIR=/data/outbox \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e APP_BASE_URL=https://monitor.example.com \
  -e ALLOW_LOCAL_FETCH=0 \
  -e DEMO_ENABLED=0 \
  -e ALLOW_PLAN_SWITCH=0 \
  -e TRUST_PROXY=1 \
  -e MAIL_FROM="Pricewatch <alerts@example.com>" \
  -e SMTP_HOST=smtp.postmarkapp.com \
  -e SMTP_PORT=587 \
  -e SMTP_USER=... \
  -e SMTP_PASS=... \
  pricewatch
```

Production checklist:

- `NODE_ENV=production` and a real `SESSION_SECRET`. The process refuses to boot in production without one.
- `ALLOW_LOCAL_FETCH=0` so the server cannot be pointed at localhost. Private and metadata addresses are blocked either way.
- `DEMO_ENABLED=0` so visitors cannot edit the sample page.
- `ALLOW_PLAN_SWITCH=0`. New accounts stay on the free plan until you set `users.plan` to `seller` or `research`.
- `APP_BASE_URL` must be the public `https` origin. Alert links are built from it.
- Do not commit `.env`. Copy `server/.env.example` and fill it in on the host.
- Run a single checker. Either leave `CHECKER_ENABLED=1` (default, every `CHECK_INTERVAL_SECONDS`) or set it to `0` and cron `npm run check` once a minute. Two checkers are safe against double email, but they still double-fetch.
- Checkout for Seller and Research is not in this repo. The weekly intel products already use Polar. Add Change Monitor products there (or another biller) and set `users.plan` from the paid webhook before charging anyone. Limits in the app match the table above.

If the marketing site stays on GitHub Pages and the service lives on another host, point the “Start free” links at that host. On one host (the Docker image, or a reverse proxy), the relative links already land on `/app`.

### Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port. Default `8787`. |
| `APP_BASE_URL` | Public origin used in alert links. |
| `SESSION_SECRET` | Signs session cookies. Required in production. |
| `DATABASE_PATH` | SQLite file. Default `server/data/pricewatch.sqlite`. |
| `CHECKER_ENABLED` | `1` runs the scheduler in the web process. |
| `CHECK_INTERVAL_SECONDS` | How often the scheduler looks for due monitors. Minimum 15. |
| `FETCH_MIN_INTERVAL_MS` | Minimum gap between fetches to the same host. Default `2000`. |
| `FETCH_TIMEOUT_MS` / `FETCH_MAX_BYTES` | Page fetch limits. |
| `USER_AGENT` | Sent on every fetch. Default identifies `PricewatchBot`. |
| `ALLOW_LOCAL_FETCH` | Allow `localhost` and `127.0.0.1`. On for local dev, off in production. |
| `DEMO_ENABLED` | Sample store and the simulate-change buttons. |
| `ALLOW_PLAN_SWITCH` | Dev-only plan picker. Off in production. |
| `TRUST_PROXY` | Trust `X-Forwarded-Proto` so the session cookie is marked Secure. |
| `MAIL_FROM` | From address. Must be a verified sender at your provider. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | SMTP. Leave `SMTP_HOST` empty to use the console/outbox mailer. |
| `MAIL_OUTBOX` | Also write each message to `OUTBOX_DIR`. Default on when SMTP is unset. |
| `OUTBOX_DIR` | Where the dev mailer writes `.txt` alerts. |

## Tests

```bash
npm test
```

The suite checks that noise does not create a diff, that price and product changes produce an old-vs-new summary, that copy-only edits are caught in whole-page mode and ignored in price-only mode, that `robots.txt` allow/disallow rules are honored, and that the HTTP app can sign up, watch the sample page, detect a change, and write an alert email.
