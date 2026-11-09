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

`https://<your-service>/polar/webhook`

Subscribe to `subscription.created`, `subscription.active`, `subscription.updated`, `subscription.canceled`, and `subscription.revoked`.

Copy the signing secret into `POLAR_WEBHOOK_SECRET`. The service verifies it with Polar’s SDK (Standard Webhooks, and the older Polar HMAC secret format).

Set `POLAR_SERVER=production` for this live org. Use `sandbox` only if you are pointing the token at Polar’s sandbox.

## 3. Payout account

Open Finance, then Account, in that same Polar org. Connect the Nigerian bank account and confirm payouts are in NGN. This is the existing Pricewatch payout account, not a new organization.

## 4. Resend

Create a Resend account and add the domain you will send from (for example `pricewatch` on your domain).

In Resend, open the domain and add the DNS records it shows. You need SPF and DKIM before mail will be trusted. Resend displays the exact TXT and CNAME values. Copy those. Do not invent them. After they verify, set:

```
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASS=<Resend API key>
MAIL_FROM="Pricewatch <alerts@your-domain>"
```

`MAIL_FROM` must be an address on the verified domain. Leave `SMTP_HOST` empty on a laptop and messages are written to the log and `OUTBOX_DIR` instead.

## 5. Render

A Starter instance (or anything with a persistent disk) is required. The free instance disk is ephemeral and would wipe accounts.

1. Push this repo to GitHub.
2. In Render, create a Blueprint from `render.yaml`, or a Docker web service with root directory `/` and Dockerfile `Dockerfile`.
3. Confirm the disk is mounted at `/var/data` and `DATABASE_PATH=/var/data/pricewatch.sqlite`.
4. Set the env vars in the next section. `render.yaml` marks the secrets as values you type in.
5. Keep instance count at 1. The checker is a timer inside this process. A second instance would fetch the same pages twice.
6. Deploy. `GET /health` should return `{"ok":true}`.

Fly.io is the alternative in `fly.toml`. Create a 1GB volume named `pricewatch_data` in the same region, set the same secrets with `fly secrets set`, and leave `auto_stop_machines` off so the checker is not shut down between requests.

## 6. Env vars

| Name | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `1` |
| `APP_BASE_URL` | `https://<your-service>` with no trailing slash |
| `SESSION_SECRET` | long random string |
| `DATABASE_PATH` | `/var/data/pricewatch.sqlite` on Render, `/data/pricewatch.sqlite` on Fly |
| `CHECKER_ENABLED` | `1` |
| `ALLOW_LOCAL_FETCH` | `0` |
| `DEMO_ENABLED` | `0` |
| `ALLOW_PLAN_SWITCH` | `0` |
| `POLAR_ACCESS_TOKEN` | token from the existing org |
| `POLAR_WEBHOOK_SECRET` | webhook signing secret |
| `POLAR_SELLER_PRODUCT_ID` | Seller product UUID, or an existing product you attach |
| `POLAR_RESEARCH_PRODUCT_ID` | Research product UUID, or an existing product you attach |
| `POLAR_SERVER` | `production` |
| `SMTP_HOST` | `smtp.resend.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `resend` |
| `SMTP_PASS` | Resend API key |
| `MAIL_FROM` | verified from-address |

## 7. Point the marketing buttons at the service

Edit the single constant in `app-url.js`:

```js
window.PRICEWATCH_APP_ORIGIN = "https://<your-service>";
```

Commit and push. GitHub Pages will send “Start free” to `https://<your-service>/app/signup`. Leave the constant empty if the Node process is serving the marketing pages on the same host.

## 8. Smoke test

1. Open `/health`.
2. Sign up with a real inbox. Open the confirmation link. The message is in Resend’s log if it does not arrive.
3. Add `https://example.com`, choose daily, and confirm the monitor is saved.
4. Try an hourly check on the free plan. The server should refuse it.
5. From Settings, start Seller checkout. Pay in Polar test mode only if `POLAR_SERVER=sandbox`. On production, use a real card you can refund.
6. In Polar, open the webhook delivery. It should be 202. The account plan should read Seller, and hourly should be allowed.
7. Open “Manage or cancel in Polar”, cancel, and confirm the webhook sets the plan back to Watch.
8. Open the unsubscribe link in an alert and confirm later checks do not email.
