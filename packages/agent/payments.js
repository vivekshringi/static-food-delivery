import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const storageDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(here, "../server/storage");
const PAYMENTS_FILE = path.join(storageDir, "payments.json");

// One payment record per chat thread: pending -> paid -> finalized.
let queue = Promise.resolve();
function withLock(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function readAll() {
  try {
    return JSON.parse(await readFile(PAYMENTS_FILE, "utf-8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export async function getAllPayments() {
  return readAll();
}

export async function getPayment(threadId) {
  return (await readAll())[threadId] ?? null;
}

export function updatePayment(threadId, update) {
  return withLock(async () => {
    const all = await readAll();
    const current = all[threadId] ?? null;
    const next = typeof update === "function" ? update(current) : update;
    if (next === undefined) return current;
    all[threadId] = next;
    await writeFile(PAYMENTS_FILE, JSON.stringify(all, null, 2), "utf-8");
    return next;
  });
}

function paypalBase() {
  return process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

export function getPaypalClientId() {
  return process.env.PAYPAL_CLIENT_ID || "";
}

async function accessToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PayPal is not configured.");
  const response = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await response.json();
  if (!response.ok) throw new Error("PayPal authentication failed.");
  return data.access_token;
}

async function paypalRequest(pathname, body, requestId) {
  const response = await fetch(`${paypalBase()}${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || `PayPal request failed (${response.status}).`);
  }
  return data;
}

export async function createPaypalOrder(threadId, payment) {
  const data = await paypalRequest("/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [
      {
        custom_id: threadId,
        description: "ANKER order",
        amount: {
          currency_code: payment.currency,
          value: payment.amount.toFixed(2),
        },
      },
    ],
  });
  return data.id;
}

export async function capturePaypalOrder(paypalOrderId) {
  const data = await paypalRequest(
    `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
    null,
    `capture-${paypalOrderId}`
  );
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    status: data.status,
    captureId: capture?.id,
    captureStatus: capture?.status,
    payerEmail: data.payer?.email_address,
    amount: capture?.amount?.value,
    currency: capture?.amount?.currency_code,
  };
}
