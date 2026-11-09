# Deploy Pricewatch Change Monitor

The marketing site can stay on GitHub Pages. Change Monitor is the Node service in `server/`. One process serves the app and runs the checker. SQLite needs a persistent disk.

Polar is already the merchant of record for Pricewatch. The live checkout links on the site are:

| Product on the site | Checkout link |
| --- | --- |
| Scout, $19/mo | https://buy.polar.sh/polar_cl_8YWq401nq9e6UlHBeSqXP4TUUdqInBmtRsI0S1UlLwO |
| Operator, $49/mo | https://buy.polar.sh/polar_cl_lyjbaMA3toQmHvmJDSbzhwg4nPExRzveS0SZv2M0q4r |
| Team, $99/mo | https://buy.polar.sh/polar_cl_k6KkqRKD2KDrMvWZaMiHC2KFbK4MCBFJoaKBu2r8pSB |
| Outreach kit, $19 | https://buy.polar.sh/polar_cl_BWEw9YU4NaJ5ti0CmqjRzM3QnY0Eom1H7Sf5B1g0WuF |

Use that same Polar organization. Do not create a second one.

## 1. Polar products

In the existing org, open Products.

Either:

- copy the product id of an existing product you want to attach to a Change Monitor tier (Scout is the $19 product, Operator is the $49 product), or
- add two new products in that org: Seller at $19/mo and Research at $49/mo.

Paste the product UUIDs into `POLAR_SELLER_PRODUCT_ID` and `POLAR_RESEARCH_PRODUCT_ID`. Those are not the `polar_cl_…` checkout-link ids.

Weekly-intel checkout links keep working either way. A subscription changes a Change Monitor account only when its product id is one of those two env vars.

## 2. Polar access token and webhook

In the same org, create an organization access token (`POLAR_ACCESS_TOKEN`) that can create checkouts and customer sessions.

Add a webhook endpoint:

`https://pricewatch-2wxd.onrender.com/polar/webhook`

Subscribe to `subscription.created`, `subscription.active`, `subscription.updated`, `subscription.canceled`, and `subscription.revoked`.

Copy the signing secret into `POLAR_WEBHOOK_SECRET`. The service verifies it with Polar’s SDK (Standard Webhooks, and the older Polar HMAC secret format).

Set `POLAR_SERVER=production` for this live org. Use `sandbox` only if you are pointing the token at Polar’s sandbox.

## 3. Payout account

Open Finance, then Account, in that same Polar org. Connect the Nigerian bank account and confirm payouts are in NGN. This is the existing Pricewatch payout account, not a new organization.

## 4. Turso

The free Render service has no disk. Accounts and snapshots live in Turso (hosted libSQL, free tier).

1. Create a Turso account and a database in the Turso dashboard or CLI. Do not put the database file on Render.
2. Copy the database URL (`libsql://...`) into `TURSO_DATABASE_URL`.
3. Create a database auth token and put it in `TURSO_AUTH_TOKEN`.

Leave both unset on a laptop. The app then uses the SQLite file at `DATABASE_PATH`.

## 5. Gmail

No custom domain. Use a normal Gmail account.

1. Turn on 2-Step Verification for that Google account.
2. Create an App Password (Google Account → Security → App passwords).
3. Set:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=0
SMTP_USER=you@gmail.com
SMTP_PASS=<the 16-character app password>
MAIL_FROM=you@gmail.com
MAIL_DAILY_LIMIT=450
```

Port 587 uses STARTTLS. `MAIL_FROM` must be the same Gmail address as `SMTP_USER`. Gmail’s daily cap is about 500 messages; 450 leaves a margin. When the cap is hit, the send is skipped and logged, and the alert stays queued for a later pass. Leave `SMTP_HOST` empty locally and mail is printed and written to `OUTBOX_DIR`.

## 6. Render free web service

`render.yaml` is a free plan with no disk. The instance sleeps after about 15 minutes idle, and the filesystem is wiped on restart.

1. Push this repo to GitHub.
2. In Render, create a Blueprint from `render.yaml`, or a Docker web service from `Dockerfile` on the free plan.
3. Fill the `sync: false` env vars from the table below. Do not set `DATABASE_PATH` to a Render path.
4. Deploy. `GET /health` should return `{"ok":true}`.
5. On boot the process catches up on monitors whose next check is already due. While the process is awake, the in-process timer keeps checking.

## 7. Keep the free instance awake

Render will not run the timer while the service is asleep. `.github/workflows/keepalive.yml` runs every 10 minutes.

1. In the GitHub repo, set the Actions variable `APP_URL` to `https://pricewatch-2wxd.onrender.com` with no trailing slash.
2. Set the Actions secret `CRON_SECRET` to the same value as Render’s `CRON_SECRET`.
3. The workflow calls `/health` and `GET /cron/tick` with `Authorization: Bearer <CRON_SECRET>`. If `APP_URL` is empty, the job exits without failing.

`/cron/tick` runs one due-check pass. It returns 401 when the secret is missing or wrong.

## 8. Env vars

| Name | Required in production | Value |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` |
| `TRUST_PROXY` | yes | `1` |
| `APP_BASE_URL` | yes | `https://pricewatch-2wxd.onrender.com` |
| `SESSION_SECRET` | yes | long random string |
| `CRON_SECRET` | yes | long random string, also stored as a GitHub Actions secret |
| `TURSO_DATABASE_URL` | yes | `libsql://...` from Turso |
| `TURSO_AUTH_TOKEN` | yes | Turso database token |
| `CHECKER_ENABLED` | yes | `1` |
| `ALLOW_LOCAL_FETCH` | yes | `0` |
| `DEMO_ENABLED` | yes | `0` |
| `ALLOW_PLAN_SWITCH` | yes | `0` |
| `POLAR_ACCESS_TOKEN` | for paid plans | token from the existing org |
| `POLAR_WEBHOOK_SECRET` | for paid plans | webhook signing secret |
| `POLAR_SELLER_PRODUCT_ID` | for paid plans | Seller product UUID, or an existing product you attach |
| `POLAR_RESEARCH_PRODUCT_ID` | for paid plans | Research product UUID, or an existing product you attach |
| `POLAR_SERVER` | for paid plans | `production` |
| `SMTP_HOST` | yes | `smtp.gmail.com` |
| `SMTP_PORT` | yes | `587` |
| `SMTP_SECURE` | yes | `0` |
| `SMTP_USER` | yes | the Gmail address |
| `SMTP_PASS` | yes | Google app password |
| `MAIL_FROM` | yes | the same Gmail address |
| `MAIL_DAILY_LIMIT` | no | `450` |

Local only: `DATABASE_PATH` (default `server/data/pricewatch.sqlite`), `PORT`, `MAIL_OUTBOX`, `LOG_MAIL`, `OUTBOX_DIR`, `FETCH_MIN_INTERVAL_MS`, `FETCH_TIMEOUT_MS`, `FETCH_MAX_BYTES`, `CHECK_INTERVAL_SECONDS`, `USER_AGENT`. Do not rely on `DATABASE_PATH` on Render.

## 7. Point the marketing buttons at the service

Edit the single constant in `app-url.js`:

```js
window.PRICEWATCH_APP_ORIGIN = "https://pricewatch-2wxd.onrender.com";
```

That value is already set in `app-url.js`. GitHub Pages sends “Start free” to `https://pricewatch-2wxd.onrender.com/app/signup`.

## 8. Smoke test

1. Open `/health`.
2. Sign up with a real inbox. Open the confirmation link. The message is in Resend’s log if it does not arrive.
3. Add `https://example.com`, choose daily, and confirm the monitor is saved.
4. Try an hourly check on the free plan. The server should refuse it.
5. From Settings, start Seller checkout. Pay in Polar test mode only if `POLAR_SERVER=sandbox`. On production, use a real card you can refund.
6. In Polar, open the webhook delivery. It should be 202. The account plan should read Seller, and hourly should be allowed.
7. Open “Manage or cancel in Polar”, cancel, and confirm the webhook sets the plan back to Watch.
8. Open the unsubscribe link in an alert and confirm later checks do not email.
