# Pathway — PayPal Auto-Renewing Subscriptions + Server-side Verification

Server-side billing for the Pathway app using the PayPal REST API. Monthly and
yearly plans are **true auto-renewing subscriptions** (PayPal Billing Plans);
the Founder plan is a one-time order.

## Features
- **`POST /api/checkout`** — creates a PayPal **subscription** (`premium`,
  `premium_yearly`) or a one-time **order** (`founder`) and returns the approval link.
- **`GET /api/capture`** — activates an approved subscription (`subscription_id`)
  or captures a one-time order (`order_id`).
- **`POST /api/webhook`** — verifies PayPal's signed webhook and uses
  `BILLING.SUBSCRIPTION.*` / `PAYMENT.SALE.COMPLETED` events as the source of truth
  for entitlement (activations, cancellations, suspensions, renewals).
- **`GET /api/health`** — liveness + mode.

## Plans
| id | type | price | billing |
|----|------|-------|---------|
| `premium` | subscription | $4.99 | auto-renews monthly |
| `premium_yearly` | subscription | $39.99 | auto-renews yearly |
| `founder` | one-time | $99.00 | lifetime |

## How recurring billing works
1. The server lazily creates a PayPal **Catalog product** + **Billing Plan** per
   subscription tier (or uses `PAYPAL_PLAN_PREMIUM(_YEARLY)` env IDs if you pre-created them).
2. `/api/checkout` creates a subscription from that plan → approval URL.
3. Buyer approves on PayPal; PayPal redirects to `APP_URL/?checkout=success&subscription_id=…`.
4. `/api/capture?subscription_id=…` calls `POST /v1/billing/subscriptions/{id}/activate`.
5. PayPal auto-bills on the cadence forever; each renewal fires `PAYMENT.SALE.COMPLETED`,
   which the webhook records (keeps entitlement fresh).
6. `BILLING.SUBSCRIPTION.CANCELLED / SUSPENDED / EXPIRED` revoke entitlement.

## Local run
```bash
cd pathway-server
npm install
cp .env.example .env        # fill PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET
npm start                   # -> http://localhost:8787
```

## Wire the frontend (live)
```js
setLiveMode('https://your-server-url'); // sets BILLING.mode='live', provider=paypal, baseUrl
```
(or set `BILLING.mode='live'` + `BILLING.baseUrl`; the app also reads
`pathway_billing_mode` / `pathway_api_base` from localStorage).
On return the app reads `subscription_id` (subscription) or `token` (order) and
calls `/api/capture` to unlock Premium server-side-verified.

## Get PayPal credentials
- **Sandbox:** developer.paypal.com → Apps & Credentials → create an app. Use
  sandbox buyer accounts to test payments. `PAYPAL_MODE=sandbox`.
- **Live:** create/use a **Live** app with **Live** API credentials, set
  `PAYPAL_MODE=live`. (Sandbox and live keys are different.)

## Webhook setup (one-time)
1. PayPal dashboard → your app → **Webhooks → Add Webhook**.
2. URL: `https://<your-server>/api/webhook`
3. Events: `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`,
   `BILLING.SUBSCRIPTION.SUSPENDED`, `BILLING.SUBSCRIPTION.EXPIRED`,
   `PAYMENT.SALE.COMPLETED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`.
4. Set `PAYPAL_WEBHOOK_URL` in `.env` to the same URL (used in signature verification).

## Environment
See `.env.example` — `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MODE`,
`APP_URL`, `CURRENCY`, `PORT`, `PAYPAL_WEBHOOK_URL`, optional `PAYPAL_PLAN_*`.

## Security notes
- `PAYPAL_CLIENT_SECRET` never ships to the browser.
- Webhooks are rejected unless PayPal's cert-based signature verifies.
- The store is in-memory; for production use Postgres/Redis so state survives restarts.