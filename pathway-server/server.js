/**
 * Pathway — PayPal checkout + auto-renewing subscriptions + server-side verification.
 *
 * Endpoints:
 *   POST /api/checkout  -> creates a PayPal Subscription (premium/premium_yearly)
 *                          or a one-time Order (founder). Returns {url, id, type}.
 *   GET  /api/capture   -> activates a subscription OR captures a one-time order.
 *   POST /api/webhook   -> verifies the PayPal signature; BILLING.SUBSCRIPTION.*
 *                          events are the source of truth for subscription state.
 *   GET  /api/health    -> liveness + config check.
 *
 * Recurring billing uses PayPal Billing Plans (Catalog products + plans). Each
 * plan auto-bills on its cadence. The webhook events BILLING.SUBSCRIPTION.ACTIVATED
 * / .CANCELLED / .SUSPENDED / .EXPIRED / PAYMENT.SALE.COMPLETED drive entitlement.
 *
 * Run locally:
 *   cd pathway-server && npm install && cp .env.example .env && npm start
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const MODE = process.env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox';
const BASE = MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const APP_URL = (process.env.APP_URL || 'http://localhost:8080').replace(/\/$/, '');
const CURRENCY = (process.env.CURRENCY || 'USD').toUpperCase();
const WEBHOOK_URL = process.env.PAYPAL_WEBHOOK_URL || (APP_URL + '/api/webhook');
const PORT = process.env.PORT || 8787;

/** type: 'sub' = auto-renewing billing plan; 'one' = one-time order. */
const PLANS = {
  premium: {
    type: 'sub', name: 'Premium Monthly', amount: 4.99,
    interval_unit: 'MONTH', interval_count: 1,
    paypalPlanId: process.env.PAYPAL_PLAN_PREMIUM || null
  },
  premium_yearly: {
    type: 'sub', name: 'Premium Yearly', amount: 39.99,
    interval_unit: 'YEAR', interval_count: 1,
    paypalPlanId: process.env.PAYPAL_PLAN_PREMIUM_YEARLY || null
  },
  founder: {
    type: 'one', name: 'Founder Lifetime', amount: 99.00,
    paypalPlanId: null
  }
};

/** In-memory store. Swap for Postgres/Redis in production. */
const subs = new Map(); // key: subscription id OR order id -> { active, planId, sub:bool }

// ---- PayPal access token (cached) -------------------------------------------
let tokenCache = { token: null, exp: 0 };
async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('PayPal not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.');
  const auth = 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
  const r = await fetch(BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const d = await r.json();
  if (!r.ok) throw new Error('PayPal auth failed: ' + (d.error_description || d.error || r.status));
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in - 30) * 1000 };
  return tokenCache.token;
}

// ---- Billing plan management --------------------------------------------------
let productCache = { id: null };
const planKeyByPaypal = new Map(); // paypal plan_id -> our key (premium/premium_yearly)

async function ensureProduct(token) {
  if (productCache.id) return productCache.id;
  const r = await fetch(BASE + '/v1/catalogs/products', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Pathway Premium',
      description: 'Pathway premium membership',
      type: 'SERVICE',
      category: 'SOFTWARE'
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Product create failed: ' + JSON.stringify(d.details || d.message));
  productCache.id = d.id;
  return d.id;
}

async function ensurePaypalPlan(token, key) {
  const plan = PLANS[key];
  if (plan.paypalPlanId) { planKeyByPaypal.set(plan.paypalPlanId, key); return plan.paypalPlanId; }
  if (planKeyByPaypal.has(plan.paypalPlanId)) return plan.paypalPlanId;
  const pid = await ensureProduct(token);
  const r = await fetch(BASE + '/v1/billing/plans', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product_id: pid,
      name: plan.name,
      description: 'Pathway ' + plan.name,
      billing_cycles: [{
        frequency: { interval_unit: plan.interval_unit, interval_count: plan.interval_count },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0, // 0 = indefinite
        pricing_scheme: { fixed_price: { value: plan.amount.toFixed(2), currency_code: CURRENCY } }
      }],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
      taxes: { percentage: 0, inclusive: false }
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Billing plan create failed: ' + JSON.stringify(d.details || d.message));
  planKeyByPaypal.set(d.id, key);
  plan.paypalPlanId = d.id;
  return d.id;
}

/* ----------------- Create a subscription or order --------------------------- */
app.post('/api/checkout', express.json(), async (req, res) => {
  const key = req.body && req.body.planId;
  const plan = PLANS[key];
  if (!plan) return res.status(400).json({ error: 'Unknown plan: ' + key });
  try {
    const token = await getToken();
    if (plan.type === 'sub') {
      const planId = await ensurePaypalPlan(token, key);
      const r = await fetch(BASE + '/v1/billing/subscriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_id: planId,
          quantity: 1,
          application_context: {
            brand_name: 'Pathway',
            user_action: 'SUBSCRIBE_NOW',
            return_url: APP_URL + '/?checkout=success',
            cancel_url: APP_URL + '/?checkout=cancelled'
          }
        })
      });
      const d = await r.json();
      if (!r.ok) return res.status(500).json({ error: JSON.stringify(d.details || d.message) });
      const approve = (d.links || []).find(l => l.rel === 'approve');
      if (!approve) return res.status(500).json({ error: 'No approval link returned' });
      return res.json({ url: approve.href, id: d.id, type: 'sub' });
    }
    // one-time order (founder)
    const r = await fetch(BASE + '/v2/checkout/orders', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ custom_id: key, description: plan.name, amount: { currency_code: CURRENCY, value: plan.amount.toFixed(2) } }],
        application_context: { brand_name: 'Pathway', user_action: 'PAY_NOW', return_url: APP_URL + '/?checkout=success', cancel_url: APP_URL + '/?checkout=cancelled' }
      })
    });
    const od = await r.json();
    if (!r.ok) return res.status(500).json({ error: od.message || 'Order creation failed' });
    const approve = (od.links || []).find(l => l.rel === 'approve');
    if (!approve) return res.status(500).json({ error: 'No approval link returned' });
    res.json({ url: approve.href, id: od.id, type: 'one' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* -------------------- Activate / capture ------------------------------------- */
async function activateSubscription(token, subId) {
  const a = await fetch(BASE + '/v1/billing/subscriptions/' + encodeURIComponent(subId) + '/activate', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  });
  // 204 No Content on success.
  const g = await fetch(BASE + '/v1/billing/subscriptions/' + encodeURIComponent(subId), {
    headers: { Authorization: 'Bearer ' + token }
  });
  const d = await g.json();
  const planKey = d.plan_id ? planKeyByPaypal.get(d.plan_id) : null;
  const active = d.status === 'ACTIVE' || d.status === 'APPROVED';
  if (active && d.id) subs.set(d.id, { active: true, planId: planKey || 'premium', updatedAt: Date.now() });
  return { completed: active, status: d.status, planId: planKey || 'premium', id: d.id };
}

app.get('/api/capture', async (req, res) => {
  const subId = req.query.subscription_id;
  const orderId = req.query.order_id;
  try {
    const token = await getToken();
    if (subId) return res.json(await activateSubscription(token, subId));
    if (!orderId) return res.status(400).json({ error: 'subscription_id or order_id required' });
    const cr = await fetch(BASE + '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
    });
    const d = await cr.json();
    const captured = d.purchase_units && d.purchase_units[0] && d.purchase_units[0].payments &&
                     d.purchase_units[0].payments.captures && d.purchase_units[0].payments.captures[0];
    const completed = d.status === 'COMPLETED' || (captured && captured.status === 'COMPLETED');
    const planId = (d.purchase_units && d.purchase_units[0] && d.purchase_units[0].custom_id) || 'founder';
    if (completed) subs.set(orderId, { active: true, planId, sub: false });
    res.json({ completed: !!completed, status: d.status, planId, id: orderId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* -------------------- Webhook verification ----------------------------------- */
async function verifyWebhook(headers, rawBody) {
  const tid = headers['paypal-transmission-id'];
  const ttime = headers['paypal-transmission-time'];
  const certUrl = headers['paypal-cert-url'];
  const sig = headers['paypal-transmission-sig'];
  if (!tid || !ttime || !certUrl || !sig) return false;
  if (!String(certUrl).includes('paypal.com')) return false;
  const spec = [tid, ttime, WEBHOOK_URL, rawBody].join('|');
  const certPem = await (await fetch(certUrl)).text();
  const key = crypto.createPublicKey(certPem);
  return crypto.verify('sha256', Buffer.from(spec, 'utf8'), key, Buffer.from(sig, 'base64'));
}

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const raw = req.body.toString('utf8');
  try {
    const ok = await verifyWebhook(req.headers, raw);
    if (!ok) return res.status(400).send('Webhook signature verification failed.');
  } catch (e) { return res.status(400).send('Webhook verification error: ' + e.message); }
  let evt; try { evt = JSON.parse(raw); } catch (e) { return res.status(400).send('Invalid payload'); }
  const r = evt.resource || {};
  const planKey = (r.plan_id && planKeyByPaypal.get(r.plan_id)) || 'premium';
  const id = r.id || (r.billing_agreement && r.billing_agreement.id) || r.subscription_id;
  switch (evt.event_type) {
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'PAYMENT.SALE.COMPLETED':
      if (id) subs.set(id, { active: true, planId: planKey, sub: true });
      break;
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
    case 'BILLING.SUBSCRIPTION.EXPIRED':
      if (id) subs.set(id, { active: false, planId: 'free', sub: true });
      break;
    case 'PAYMENT.CAPTURE.COMPLETED':
      if (id) subs.set(id, { active: true, planId: r.custom_id || planKey, sub: false });
      break;
    default: break;
  }
  res.json({ received: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, provider: 'paypal', mode: MODE, configured: !!(CLIENT_ID && CLIENT_SECRET) }));

app.listen(PORT, () => console.log('Pathway (PayPal ' + MODE + ') server on :' + PORT));