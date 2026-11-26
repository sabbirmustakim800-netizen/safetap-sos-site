// NowPayments proxy for SafeTap SOS.
//
// The NowPayments API key must never ship inside the APK, so the app only knows
// this server's URL. It creates an invoice, reports the payment status, and
// accepts NowPayments IPN callbacks.
//
// Environment variables:
//   NOWPAYMENTS_API_KEY    – required; API key from NowPayments → Store settings → API keys
//   NOWPAYMENTS_IPN_SECRET – required for IPN signature checks
//   PUBLIC_BASE_URL        – optional; defaults to Render's RENDER_EXTERNAL_URL
//   PRO_PRICE_USD          – optional; invoice amount, default 1.99
//   PORT                   – optional; default 8080
//
// Run: npm install && npm start

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const {
  NOWPAYMENTS_API_KEY = "",
  NOWPAYMENTS_IPN_SECRET = "",
  PUBLIC_BASE_URL = "",
  RENDER_EXTERNAL_URL = "",
  PRO_PRICE_USD = "1.99",
  PORT = "8080",
} = process.env;

const BASE_URL = (PUBLIC_BASE_URL || RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

if (!NOWPAYMENTS_API_KEY) {
  // Stay up (health checks keep passing) so the keys can be added on Render
  // without a failed deploy; every payment endpoint answers 503 until then.
  console.warn("NOWPAYMENTS_API_KEY is not set — payment endpoints will answer 503.");
}
if (!NOWPAYMENTS_IPN_SECRET) {
  console.warn("NOWPAYMENTS_IPN_SECRET is not set — IPN callbacks will be rejected.");
}

const API = "https://api.nowpayments.io/v1";
const app = express();
app.set("trust proxy", true);

// Keep the parsed body: NowPayments signs the JSON with alphabetically sorted keys.
app.use(express.json({ limit: "100kb" }));

app.use(
  express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "public"), {
    extensions: ["html"],
  })
);

/** Production note: replace this Map with a real database. */
const payments = new Map();

const PLANS = {
  pro_monthly: { amount: PRO_PRICE_USD, days: 31, title: "SafeTap SOS Pro — 1 month" },
};

function configured() {
  return Boolean(NOWPAYMENTS_API_KEY);
}

async function nowpayments(endpoint, init = {}) {
  const res = await fetch(`${API}${endpoint}`, {
    ...init,
    headers: {
      "x-api-key": NOWPAYMENTS_API_KEY,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? safeJson(text) : {};
  if (!res.ok) {
    throw new Error(data?.message || `NowPayments HTTP ${res.status}`);
  }
  return data;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function record(paymentId, patch = {}) {
  const existing = payments.get(paymentId) || {
    paymentId,
    plan: "pro_monthly",
    status: "waiting",
    createdAt: Date.now(),
  };
  const next = { ...existing, ...patch };
  payments.set(paymentId, next);
  return next;
}

app.get("/health", (_req, res) =>
  res.json({ ok: true, configured: configured(), ipn: Boolean(NOWPAYMENTS_IPN_SECRET) })
);

app.post("/api/payments/nowpayments/invoice", async (req, res) => {
  if (!configured()) return res.status(503).json({ error: "payments_not_configured" });

  const plan = String(req.body?.plan || "pro_monthly");
  const config = PLANS[plan];
  if (!config) return res.status(400).json({ error: "unknown_plan" });

  try {
    const orderId = `safetap-${plan}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const invoice = await nowpayments("/invoice", {
      method: "POST",
      body: JSON.stringify({
        price_amount: Number(config.amount),
        price_currency: "usd",
        order_id: orderId,
        order_description: config.title,
        ipn_callback_url: `${BASE_URL}/api/payments/nowpayments/ipn`,
        success_url: `${BASE_URL}/paid.html`,
        cancel_url: `${BASE_URL}/cancel.html`,
      }),
    });

    const paymentId = String(invoice.id ?? "");
    if (!paymentId || !invoice.invoice_url) throw new Error("invoice response missing id or url");

    record(paymentId, { orderId, plan, status: invoice.payment_status || "waiting" });
    res.json({ paymentId, invoiceUrl: invoice.invoice_url });
  } catch (error) {
    console.error("invoice failed:", error.message);
    res.status(502).json({ error: "invoice_failed" });
  }
});

app.get("/api/payments/nowpayments/status", async (req, res) => {
  const paymentId = String(req.query.payment_id || "");
  if (!paymentId) return res.status(400).json({ error: "missing_payment_id" });
  if (!configured()) return res.status(503).json({ error: "payments_not_configured" });

  const local = payments.get(paymentId);
  try {
    // Ask NowPayments directly so a missed IPN cannot strand a paying user.
    const remote = await nowpayments(`/payment/${encodeURIComponent(paymentId)}`);
    const status = String(remote.payment_status || local?.status || "waiting");
    const plan = local?.plan || "pro_monthly";
    record(paymentId, { status, plan });

    res.json({
      paymentId,
      status,
      plan,
      // Entitlement: only a settled payment may unlock Pro on the device.
      pro: status === "finished" || status === "confirmed",
    });
  } catch (error) {
    if (!local) return res.status(404).json({ error: "unknown_payment" });
    res.json({ paymentId, status: local.status, plan: local.plan, pro: false });
  }
});

app.post("/api/payments/nowpayments/ipn", (req, res) => {
  if (!NOWPAYMENTS_IPN_SECRET) {
    return res.status(503).json({ error: "ipn_not_configured" });
  }
  const signature = req.get("x-nowpayments-sig") || "";
  const expected = crypto
    .createHmac("sha512", NOWPAYMENTS_IPN_SECRET)
    .update(canonicalJson(req.body))
    .digest("hex");

  const valid =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return res.status(401).json({ error: "bad_signature" });

  const paymentId = String(req.body?.payment_id ?? "");
  const status = String(req.body?.payment_status ?? "");
  if (paymentId) record(paymentId, { status });
  console.log("ipn", paymentId, status);
  res.json({ ok: true });
});

/** NowPayments signs over JSON with alphabetically sorted keys. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`SafeTap payments proxy listening on ${PORT} (${BASE_URL})`);
});
