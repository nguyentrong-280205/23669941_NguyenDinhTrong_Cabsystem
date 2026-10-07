'use strict';
// Local provider adapter for coursework. Charges/messages are durable and idempotent.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../shared/lib/core');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const dir = process.env.SANDBOX_DATA_DIR || path.resolve(__dirname, '../.sandbox'); fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'records.json');
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { charges: {}, messages: {} };
function save() { fs.writeFileSync(`${file}.tmp`, JSON.stringify(state)); fs.renameSync(`${file}.tmp`, file); }
const app = express(); app.use(express.json({ limit: '64kb' }));
function authenticate(name) { return (req,res,next) => { try { C.demand(C.equal(req.headers.authorization, `Bearer ${C.secret(name)}`), 401, 'UNAUTHORIZED', 'Invalid provider credential'); next(); } catch (e) { next(e); } }; }
app.get('/api/v1/health-checks', (_req,res) => res.json({ status: 'healthy' }));
app.post('/api/v1/charges', authenticate('PAYMENT_PROVIDER_SECRET'), (req,res,next) => {
  try {
    const key = req.headers['idempotency-key']; C.demand(typeof key === 'string' && key === req.body.paymentId && Number.isSafeInteger(req.body.amount) && req.body.amount >= 0 && req.body.currency === 'VND', 400, 'VALIDATION_ERROR', 'Invalid charge');
    const old = state.charges[key]; if (old) C.demand(old.requestHash === C.hash(req.body), 409, 'IDEMPOTENCY_CONFLICT', 'Charge key reused');
    if (!old) { state.charges[key] = { paymentId: key, providerTransactionId: C.id(), amount: req.body.amount, currency: req.body.currency, status: 'COMPLETED', requestHash: C.hash(req.body), callbackDelivered: false, chargeCount: 1 }; save(); }
    res.json({ providerTransactionId: state.charges[key].providerTransactionId });
  } catch (e) { next(e); }
});
app.get('/api/v1/charges/:id', authenticate('PAYMENT_PROVIDER_SECRET'), (req,res) => { const row = state.charges[req.params.id]; res.status(row ? 200 : 404).json(row || { code: 'NOT_FOUND' }); });
app.post('/api/v1/messages', authenticate('NOTIFICATION_PROVIDER_SECRET'), (req,res,next) => {
  try { const key = req.headers['idempotency-key']; C.demand(key, 400, 'VALIDATION_ERROR', 'Delivery key required'); const old = state.messages[key]; if (old) C.demand(old.requestHash === C.hash(req.body), 409, 'IDEMPOTENCY_CONFLICT', 'Delivery key reused');
    if (!old) { state.messages[key] = { deliveryId: key, encryptedPayload: C.encrypt(req.body), requestHash: C.hash(req.body), createdAt: C.now() }; save(); }
    res.json({ deliveryId: key, status: 'SENT' });
  } catch (e) { next(e); }
});
app.get('/api/v1/messages', authenticate('NOTIFICATION_PROVIDER_SECRET'), (_req,res) => res.json({ items: Object.values(state.messages).map(m => ({ deliveryId: m.deliveryId, createdAt: m.createdAt, ...C.decrypt(m.encryptedPayload) })) }));
app.use((e,_req,res,_next) => res.status(e.status || 500).json({ code: e.code || 'PROVIDER_ERROR', message: e.status < 500 ? e.message : 'Provider error' }));
let working = false;
const timer = setInterval(async () => {
  if (working) return; working = true;
  try { for (const row of Object.values(state.charges).filter(x => !x.callbackDelivered)) {
    const raw = JSON.stringify({ paymentId: row.paymentId, providerTransactionId: row.providerTransactionId, status: row.status, amount: row.amount, currency: row.currency });
    try { const response = await fetch(`${process.env.GATEWAY_URL || 'http://gateway:8080'}/api/v1/payment-callbacks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-provider-signature': C.hmac(raw, 'PAYMENT_PROVIDER_SECRET') }, body: raw, signal: AbortSignal.timeout(4000) }); if (response.ok) { row.callbackDelivered = true; save(); } } catch (_) { /* retry same callback */ }
  } } finally { working = false; }
}, 1000);
const server = app.listen(Number(process.env.SANDBOX_PORT || 3090), '0.0.0.0');
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => { clearInterval(timer); server.close(() => process.exit(0)); });
