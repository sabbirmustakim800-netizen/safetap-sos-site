# SafeTap payments proxy (NowPayments)

Small Express service that creates NowPayments invoices, reports payment status
and verifies IPN callbacks. The Android app only knows this service's URL — the
NowPayments API key never ships in the APK.

Live: https://safetap-sos-pay.onrender.com

## Endpoints

```
GET  /health
  -> {"ok":true,"configured":true,"ipn":true}

POST /api/payments/nowpayments/invoice   {"plan":"pro_monthly"}
  -> {"paymentId":"...","invoiceUrl":"https://nowpayments.io/payment/?iid=..."}

GET  /api/payments/nowpayments/status?payment_id=...
  -> {"paymentId":"...","status":"waiting|confirming|confirmed|finished|failed|expired","plan":"pro_monthly","pro":false}

POST /api/payments/nowpayments/ipn      (called by NowPayments, HMAC-SHA512 signed)

GET  /paid.html, /cancel.html           (checkout return pages)
```

`pro` is `true` only for `finished` / `confirmed`, so the app never unlocks Pro
on a pending or failed payment.

## Render

- Type: Web Service, runtime Node
- Root directory: `server`
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`
- Environment variables: `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`
  (optional: `PRO_PRICE_USD`, `PUBLIC_BASE_URL` — it defaults to Render's
  `RENDER_EXTERNAL_URL`)

Without `NOWPAYMENTS_API_KEY` the service still starts; payment endpoints answer
`503 payments_not_configured` and `/health` reports `configured:false`.

## NowPayments dashboard

Set the IPN callback URL to

```
https://safetap-sos-pay.onrender.com/api/payments/nowpayments/ipn
```

(the invoice request also sends it, so this is a fallback).

## Android side

`PAYMENT_API_BASE` must point at this service (see `app/build.gradle.kts`), and
the CI build reads it from the `PAYMENT_API_BASE` repository secret. When it is
empty the Plan screen shows that payments are not connected in that build.

## Before scaling up

- Replace the in-memory `payments` Map with a database; a restart only loses the
  status cache (status is re-read from NowPayments on demand).
- Bind a payment to a device/account id so one invoice cannot unlock unlimited
  phones, and add rate limiting to the invoice endpoint.
- Keep the API key and IPN secret in Render's environment only.

## Local test

```bash
cd server
npm install
NOWPAYMENTS_API_KEY=... NOWPAYMENTS_IPN_SECRET=... npm start
curl -s localhost:8080/health
```
