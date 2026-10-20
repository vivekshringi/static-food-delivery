/* eslint-disable no-console */
import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import { tool, context, createMiddleware } from "langchain";
import * as z from "zod";
import * as dotenv from "dotenv";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import readline from "node:readline/promises";

import { SYSTEM_PROMPT_TEXT } from "./prompt.js";
import { getPayment, updatePayment } from "./payments.js";
import { logPayment } from "./logger.js";
import { createRateLimiter } from "./rate-limit.js";
import { withFileLock } from "./file-lock.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

dotenv.config({ path: path.join(repoRoot, ".env") });

process.env.LANGCHAIN_API_KEY = process.env.LANGCHAIN_API_KEY ?? "";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
process.env.LANGSMITH_TRACING = process.env.LANGSMITH_TRACING ?? "";
process.env.LANGSMITH_ENDPOINT = process.env.LANGSMITH_ENDPOINT ?? "";
process.env.LANGSMITH_PROJECT = process.env.LANGSMITH_PROJECT ?? "";

// Any model string accepted by LangChain's `initChatModel` works here, e.g.
// "openai:gpt-4o", "ollama:llama3.1" or "ollama:deepseek-v4.1-flash:cloud".
// Ollama needs a tool-calling capable model and the "@langchain/ollama" package;
// the local server URL is taken from OLLAMA_BASE_URL (default http://127.0.0.1:11434).
export const DEFAULT_MODEL = process.env.AGENT_MODEL?.trim() || "openai:gpt-4o";

// The restaurant's local time decides the greeting.
const TIME_ZONE = "Europe/Berlin";
const storageDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(here, "../server/storage");
const ORDERS_FILE = path.join(storageDir, "orders.json");

import menu from "../server/storage/anker_menu.json" with { type: "json" };

const CUSTOMERS_FILE = path.join(storageDir, "alreadyACustomerlist.json");
const BUNDLED_CUSTOMERS_FILE = path.resolve(here, "../server/storage/alreadyACustomerlist.json");

function readCustomerFile(file) {
  const parsed = JSON.parse(readFileSync(file, "utf-8"));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Returns the current customer numbers. The file is read on every call, so changes made from the
 * admin page apply immediately; the bundled list is the fallback when DATA_DIR has none yet.
 */
export function getCustomerNumbers() {
  let customers;
  try {
    customers = readCustomerFile(CUSTOMERS_FILE);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    customers = readCustomerFile(BUNDLED_CUSTOMERS_FILE);
  }
  return customers
    .map((customer) => String(customer?.customerNumber ?? "").trim())
    .filter(Boolean);
}

/**
 * Replaces the customer list. Numbers are trimmed, empty ones dropped and duplicates removed.
 */
export async function saveCustomerNumbers(numbers) {
  if (!Array.isArray(numbers)) throw new TypeError("numbers must be an array");
  const unique = [...new Set(numbers.map((n) => String(n ?? "").trim()).filter(Boolean))];
  if (unique.some((n) => n.length > 40 || /[\s"\\]/.test(n))) {
    throw new TypeError("Customer numbers must not contain spaces or quotes and must be short.");
  }
  await writeFile(
    CUSTOMERS_FILE,
    JSON.stringify(unique.map((customerNumber) => ({ customerNumber })), null, 2),
    "utf-8"
  );
  return unique;
}

/**
 * Checks if a customer number exists in the customer list.
 *
 * @param customerNumber - The customer number to search for
 * @returns true if found, false otherwise
 */
export function hasCustomerNumber(customerNumber) {
  if (typeof customerNumber !== "string" || !customerNumber.trim()) {
    throw new TypeError("customerNumber must be a non-empty string");
  }
  return getCustomerNumbers().includes(customerNumber.trim());
}

// Failed verifications are counted in code. The per-thread counter keeps one conversation from
// retrying forever, and the per-client counter stops a caller from resetting that limit by opening
// a fresh thread. Without the client scope, a new threadId would grant a fresh set of guesses.
const MAX_FAILED_VERIFICATIONS = 3;
const MAX_FAILED_VERIFICATIONS_PER_CLIENT = Number(process.env.CHAT_MAX_VERIFICATION_FAILURES) || 15;
const VERIFICATION_WINDOW_MS = 15 * 60 * 1000;
const failedVerifications = createRateLimiter({
  limit: MAX_FAILED_VERIFICATIONS,
  windowMs: VERIFICATION_WINDOW_MS,
});
const failedVerificationsPerClient = createRateLimiter({
  limit: MAX_FAILED_VERIFICATIONS_PER_CLIENT,
  windowMs: VERIFICATION_WINDOW_MS,
});

const threadKey = (threadId) => `thread:${threadId ?? ""}`;
const clientKey = (clientId) => `client:${clientId ?? ""}`;

/**
 * Reports whether this thread or client still has verification attempts left.
 */
export function verificationBlocked(threadId, clientId) {
  if (!failedVerifications.check(threadKey(threadId)).allowed) return true;
  return clientId ? !failedVerificationsPerClient.check(clientKey(clientId)).allowed : false;
}

/**
 * Counts one failed verification and reports whether both scopes still allow a retry.
 */
function recordFailedVerification(threadId, clientId) {
  const threadStatus = failedVerifications.hit(threadKey(threadId));
  const clientStatus = clientId
    ? failedVerificationsPerClient.hit(clientKey(clientId))
    : { allowed: true, remaining: MAX_FAILED_VERIFICATIONS_PER_CLIENT };
  return {
    allowed: threadStatus.allowed && clientStatus.allowed,
    remaining: Math.min(threadStatus.remaining, clientStatus.remaining),
  };
}

/**
 * Clears the per-thread counter after a successful verification. The per-client counter is
 * deliberately not cleared: a customer who knows one valid number must not be able to reset the
 * budget and keep enumerating the rest.
 */
function clearVerificationAttempts(threadId) {
  failedVerifications.reset(threadKey(threadId));
}

const DAY_PRICE_UNTIL_HOUR = 16;
const collator = new Intl.Collator("de-DE", { sensitivity: "base", numeric: true });
const norm = (value) => String(value ?? "").trim().toLocaleLowerCase("de-DE");

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return norm(value);
}

/**
 * Fixed percentage taken off every final order (0-100), set with ORDER_DISCOUNT_PERCENT.
 */
export function getDiscountPercent() {
  const percent = Number(process.env.ORDER_DISCOUNT_PERCENT ?? 0);
  return Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0;
}

/**
 * "day" from the start of the day until 16:00 restaurant time, "evening" from 16:00 on.
 */
export function getPricePeriod(now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: TIME_ZONE,
    }).format(now)
  );
  return hour < DAY_PRICE_UNTIL_HOUR ? "day" : "evening";
}

// A flavour is only offered when it has a price for the period; that price is the one charged.
function toFlavour(category, flavour, period) {
  const price = flavour.price?.[period];
  if (typeof price !== "number") return undefined;
  return {
    category: category.category,
    categoryDescription: category.description,
    name: flavour.name,
    ...(flavour.description ? { description: flavour.description } : {}),
    price,
    allergens: flavour.allergens ?? [],
  };
}

function availableFlavours(period = getPricePeriod()) {
  return menu.items.flatMap((category) =>
    category.flavours
      .map((flavour) => toFlavour(category, flavour, period))
      .filter((flavour) => flavour !== undefined)
  );
}

/** Full menu for one period ("day" = lunch, "evening" = dinner), grouped by category. */
export function getMenuForPeriod(period) {
  if (period !== "day" && period !== "evening") throw new TypeError("period must be day or evening");
  const categories = menu.items
    .map((category) => ({
      category: category.category,
      description: category.description ?? "",
      flavours: category.flavours
        .map((flavour) => toFlavour(category, flavour, period))
        .filter((flavour) => flavour !== undefined)
        .map(({ name, description, price, allergens }) => ({ name, description, price, allergens })),
    }))
    .filter((category) => category.flavours.length > 0);
  return {
    currency: menu.currency ?? "EUR",
    period,
    categories,
    allergenLegend: menu.allergen_legend ?? {},
  };
}

function toCategorySummary(category) {
  return {
    category: category.category,
    ...(category.description ? { description: category.description } : {}),
  };
}

/**
 * Returns the flavours of one category (exact name, case-insensitive) that can be ordered in
 * the given period, with the price of that period.
 */
export function getFlavoursByCategory(category, period = getPricePeriod()) {
  const wanted = requireText(category, "category");
  return availableFlavours(period).filter((f) => norm(f.category) === wanted);
}

/**
 * Returns the flavours of every category whose name contains the query, for the given period.
 */
export function searchFlavoursByCategory(categoryQuery, period = getPricePeriod()) {
  const query = requireText(categoryQuery, "categoryQuery");
  return availableFlavours(period).filter((f) => norm(f.category).includes(query));
}

/**
 * Returns the categories (name and description) that have at least one flavour available in
 * the given period. Menu order by default, alphabetical (locale aware) when sorted is true.
 */
export function getCategories(sorted = true, period = getPricePeriod()) {
  const open = new Set(availableFlavours(period).map((f) => f.category));
  const categories = menu.items
    .filter((category) => open.has(category.category))
    .map(toCategorySummary);
  return sorted
    ? [...categories].sort((a, b) => collator.compare(a.category, b.category))
    : categories;
}

/**
 * Returns the categories that offer a flavour with this name (e.g. "Chicken"), each with the
 * matching flavour and its price. Exact name match first; if nothing matches exactly, flavours
 * whose name contains the text are used.
 */
export function getCategoriesByFlavourName(flavourName, period = getPricePeriod()) {
  const wanted = requireText(flavourName, "flavourName");
  const all = availableFlavours(period);
  let matches = all.filter((f) => norm(f.name) === wanted);
  if (matches.length === 0) matches = all.filter((f) => norm(f.name).includes(wanted));
  const byCategory = new Map();
  for (const flavour of matches) {
    const entry = byCategory.get(flavour.category) ?? {
      ...toCategorySummary({
        category: flavour.category,
        description: flavour.categoryDescription,
      }),
      flavours: [],
    };
    entry.flavours.push({ name: flavour.name, price: flavour.price });
    byCategory.set(flavour.category, entry);
  }
  return [...byCategory.values()];
}

/**
 * Returns the flavours priced at or above minPrice (and at or below maxPrice when given) in
 * the given period, cheapest first. Optionally limited to one category.
 */
export function getFlavoursByMinPrice(minPrice, options = {}) {
  const { maxPrice, category, period = getPricePeriod() } = options;
  if (typeof minPrice !== "number" || !Number.isFinite(minPrice)) {
    throw new TypeError("minPrice must be a number");
  }
  const wantedCategory = category?.trim() ? norm(category) : undefined;
  return availableFlavours(period)
    .filter(
      (f) =>
        f.price >= minPrice &&
        (maxPrice === undefined || f.price <= maxPrice) &&
        (!wantedCategory || norm(f.category) === wantedCategory)
    )
    .sort((a, b) => a.price - b.price || collator.compare(a.name, b.name));
}

/**
 * Returns every flavour with this name (case-insensitive) that is available in the period.
 * The same name, e.g. "Chicken", exists in several categories at different prices.
 */
export function findFlavoursByName(flavourName, period = getPricePeriod()) {
  const wanted = requireText(flavourName, "flavourName");
  return availableFlavours(period).filter((f) => norm(f.name) === wanted);
}

/**
 * Finds a flavour by name. Pass the category whenever the name can exist in several
 * categories, otherwise the first match is returned. Undefined when it is not available now.
 */
export function findFlavourByName(flavourName, category, period = getPricePeriod()) {
  const matches = findFlavoursByName(flavourName, period);
  if (!category?.trim()) return matches[0];
  const wanted = norm(category);
  return matches.find((f) => norm(f.category) === wanted);
}

function describeAllergens(codes) {
  return codes.map((code) => menu.allergen_legend[code] ?? `Unknown allergen: ${code}`);
}

/**
 * Returns the full allergen descriptions for a flavour.
 */
export function getAllergenDescriptionsByFlavourName(flavourName, category, period) {
  const flavour = findFlavourByName(flavourName, category, period);
  return flavour ? describeAllergens(flavour.allergens) : [];
}

/**
 * Returns the allergen codes for a flavour.
 */
export function getAllergensByFlavourName(flavourName, category, period) {
  return findFlavourByName(flavourName, category, period)?.allergens ?? [];
}


export const SYSTEM_PROMPT = context`${SYSTEM_PROMPT_TEXT}`;

const getCurrentTimeTool = tool(
  async () => {
    const now = new Date();
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        hourCycle: "h23",
        timeZone: TIME_ZONE,
      }).format(now)
    );
    const partOfDay =
      hour >= 5 && hour < 12
        ? "morning"
        : hour < 18 && hour >= 12
          ? "afternoon"
          : hour >= 18 && hour < 22
            ? "evening"
            : "night";
    return {
      iso: now.toISOString(),
      localTime: now.toLocaleString("de-DE", { timeZone: TIME_ZONE }),
      timeZone: TIME_ZONE,
      partOfDay,
    };
  },
  {
    name: "get_current_time",
    description:
      "Get the current time and the part of the day (morning, afternoon, evening, night). Use it to choose the greeting.",
    schema: z.object({}),
  }
);

const verifyCustomerNumberTool = tool(
  async ({ customerNumber }, config) => {
    const threadId = config?.configurable?.thread_id;
    const clientId = config?.configurable?.client_id;

    if (verificationBlocked(threadId, clientId)) {
      logPayment("verification_blocked", { threadId, clientId });
      return {
        valid: false,
        locked: true,
        error: "Too many failed attempts. Do not try again; end the conversation politely.",
      };
    }

    let valid = false;
    try {
      valid = hasCustomerNumber(customerNumber);
    } catch {
      valid = false;
    }

    if (valid) {
      clearVerificationAttempts(threadId);
      return { valid: true };
    }

    const status = recordFailedVerification(threadId, clientId);
    logPayment("verification_failed", {
      threadId,
      clientId,
      remaining: status.remaining,
      locked: !status.allowed,
    });
    return status.allowed
      ? { valid: false, remainingAttempts: status.remaining }
      : {
          valid: false,
          locked: true,
          error: "Too many failed attempts. Do not try again; end the conversation politely.",
        };
  },
  {
    name: "verify_customer_number",
    description:
      "Check whether a customer number exists. Returns { valid }. Never reveal other customer numbers. After 3 failed attempts the tool locks and reports { locked: true }; then end the conversation politely.",
    schema: z.object({
      customerNumber: z.string().describe("The number the customer entered."),
    }),
  }
);

const getCategoriesTool = tool(
  async () => ({
    period: getPricePeriod(),
    categories: getCategories(false),
  }),
  {
    name: "get_categories",
    description:
      "List the categories that can be ordered right now, each with its description, in menu order. Show the description with every category.",
    schema: z.object({}),
  }
);

const getFlavoursByCategoryTool = tool(
  async ({ category }) => {
    let flavours = getFlavoursByCategory(category);
    if (flavours.length === 0) {
      flavours = searchFlavoursByCategory(category);
    }
    if (flavours.length === 0) {
      return { found: false, message: `No flavours available for category "${category}".` };
    }
    return {
      found: true,
      period: getPricePeriod(),
      currency: menu.currency,
      flavours: flavours.map(({ category: flavourCategory, name, description, price }) => ({
        category: flavourCategory,
        name,
        ...(description ? { description } : {}),
        price,
      })),
    };
  },
  {
    name: "get_flavours_by_category",
    description:
      "List the flavours (name and current price) of the category the customer chose. Only flavours that can be ordered right now are returned. Use the exact category name from get_categories.",
    schema: z.object({
      category: z.string().describe("The chosen category name."),
    }),
  }
);

const getCategoriesByFlavourTool = tool(
  async ({ flavourName }) => {
    const categories = getCategoriesByFlavourName(flavourName);
    if (categories.length === 0) {
      return { found: false, message: `No category offers "${flavourName}" right now.` };
    }
    return { found: true, period: getPricePeriod(), currency: menu.currency, categories };
  },
  {
    name: "get_categories_by_flavour",
    description:
      "Use when the customer asks for a flavour such as 'chicken' or 'paneer' before choosing a category. Returns every category that offers it right now, with its description and the flavour price. Show them as a numbered list and let the customer pick a category.",
    schema: z.object({
      flavourName: z.string().describe("The flavour name, e.g. 'Chicken'."),
    }),
  }
);

const getFlavoursByMinPriceTool = tool(
  async ({ minPrice, maxPrice, category }) => {
    const flavours = getFlavoursByMinPrice(minPrice, { maxPrice, category });
    if (flavours.length === 0) {
      return { found: false, message: "No flavours match that price." };
    }
    return {
      found: true,
      period: getPricePeriod(),
      currency: menu.currency,
      flavours: flavours.map(({ category: flavourCategory, name, price }) => ({
        category: flavourCategory,
        name,
        price,
      })),
    };
  },
  {
    name: "get_flavours_by_min_price",
    description:
      "List the flavours that cost at least minPrice right now (optionally at most maxPrice, optionally within one category), cheapest first.",
    schema: z.object({
      minPrice: z.number().describe("Minimum price in EUR."),
      maxPrice: z.number().optional().describe("Optional maximum price in EUR."),
      category: z.string().optional().describe("Optional exact category name."),
    }),
  }
);

const findFlavourTool = tool(
  async ({ flavourName, category }) => {
    const matches = category
      ? [findFlavourByName(flavourName, category)].filter((flavour) => flavour !== undefined)
      : findFlavoursByName(flavourName);
    if (matches.length === 0) {
      return { found: false, message: `No flavour "${flavourName}" is available right now.` };
    }
    return {
      found: true,
      period: getPricePeriod(),
      currency: menu.currency,
      flavours: matches.map((flavour) => ({
        category: flavour.category,
        name: flavour.name,
        ...(flavour.description ? { description: flavour.description } : {}),
        price: flavour.price,
        allergens: describeAllergens(flavour.allergens),
      })),
    };
  },
  {
    name: "find_flavour",
    description:
      "Look up the current price and allergens of the flavour the customer chose. The same name can exist in several categories at different prices, so pass the category; if several come back, ask the customer which one.",
    schema: z.object({
      flavourName: z.string().describe("The flavour name, e.g. 'Butter Chicken'."),
      category: z.string().optional().describe("The category the flavour was chosen from."),
    }),
  }
);

// Prices and the discount come from the menu and settings, never from the model.
export function priceOrder(orderedItems, comment) {
  if (orderedItems.length === 0) {
    return { error: "The order has no items." };
  }

  const period = getPricePeriod();
  const items = [];
  const unavailable = [];
  for (const { name, category } of orderedItems) {
    const flavour = findFlavourByName(name, category, period);
    if (flavour) {
      items.push({
        name: flavour.name,
        category: flavour.category,
        price: flavour.price,
        allergens: describeAllergens(flavour.allergens),
      });
    } else {
      unavailable.push(`${name} (${category})`);
    }
  }
  if (unavailable.length > 0) {
    return { error: `Not available right now: ${unavailable.join(", ")}` };
  }

  const subtotalCents = items.reduce((sum, item) => sum + Math.round(item.price * 100), 0);
  const discountPercent = getDiscountPercent();
  const discountCents = Math.round((subtotalCents * discountPercent) / 100);
  const trimmedComment = comment?.trim().slice(0, 500);
  return {
    order: {
      items,
      priceType: period,
      subtotal: subtotalCents / 100,
      discountPercent,
      discountAmount: discountCents / 100,
      total: (subtotalCents - discountCents) / 100,
      currency: menu.currency,
      ...(trimmedComment ? { comment: trimmedComment } : {}),
    },
  };
}

export function buildOrder(customerNumber, orderedItems, comment) {
  if (!hasCustomerNumber(customerNumber)) {
    return { error: "Unknown customer number." };
  }
  const { order, error } = priceOrder(orderedItems, comment);
  if (error) return { error };
  return { order: { customerNumber: customerNumber.trim(), ...order } };
}

const orderItemsSchema = z
  .array(
    z.object({
      name: z.string().describe("Exact flavour name."),
      category: z.string().describe("Exact category the flavour belongs to."),
    })
  )
  .describe("Every ordered flavour, one entry per portion.");

const calculateOrderTool = tool(
  async ({ items }) => {
    const { order, error } = priceOrder(items);
    if (error) return { ok: false, error };
    return { ok: true, ...order };
  },
  {
    name: "calculate_order",
    description:
      "Price the current order for the summary: items with price and allergens, subtotal, fixed discount percent and amount, and the total to pay. Use these numbers in the summary; never calculate them yourself.",
    schema: z.object({ items: orderItemsSchema }),
  }
);

// Saves the order only once its payment has been captured.
export async function finalizeOrder(threadId) {
  const payment = threadId ? await getPayment(threadId) : null;
  if (!payment || payment.status === "pending") {
    logPayment("finalize_refused", { threadId, reason: "not paid", status: payment?.status ?? null });
    return { saved: false, error: "The order has not been paid yet." };
  }
  if (payment.status === "finalized") {
    logPayment("finalize_refused", { threadId, reason: "already placed" });
    return { saved: false, error: "This order was already placed." };
  }

  const order = {
    ...payment.order,
    time: new Date().toISOString(),
    payment: {
      provider: "paypal",
      status: "COMPLETED",
      paypalOrderId: payment.paypalOrderId,
      captureId: payment.captureId,
      payerEmail: payment.payerEmail,
      paidAt: payment.paidAt,
    },
  };

  // Serialised with the hourly backup cron, which reads then truncates this file. Without the
  // shared lock a payment captured during a backup could be truncated away.
  await withFileLock("orders", async () => {
    let orders = [];
    try {
      orders = JSON.parse(await readFile(ORDERS_FILE, "utf-8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    orders.push(order);
    await writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2), "utf-8");
  });

  await updatePayment(threadId, (current) => ({
    ...current,
    status: "finalized",
    finalizedAt: order.time,
  }));

  logPayment("order_finalized", {
    threadId,
    paypalOrderId: payment.paypalOrderId,
    customerNumber: order.customerNumber,
    total: order.total,
    currency: order.currency,
  });
  return { saved: true, order };
}

const preparePaymentTool = tool(
  async ({ customerNumber, items, comment }, config) => {
    const threadId = config?.configurable?.thread_id;
    const { order, error } = buildOrder(customerNumber, items, comment);
    if (error) {
      logPayment("payment_prepare_failed", { threadId, error });
      return { ready: false, error };
    }
    const existing = await getPayment(threadId);
    if (existing && existing.status !== "pending") {
      logPayment("payment_prepare_failed", { threadId, error: "already paid" });
      return { ready: false, error: "This order was already paid." };
    }
    await updatePayment(threadId, {
      status: "pending",
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      amount: order.total,
      currency: order.currency,
      order,
    });
    logPayment("payment_prepared", {
      threadId,
      customerNumber: order.customerNumber,
      subtotal: order.subtotal,
      discountPercent: order.discountPercent,
      total: order.total,
      currency: order.currency,
      itemCount: order.items.length,
    });
    return {
      ready: true,
      subtotal: order.subtotal,
      discountPercent: order.discountPercent,
      discountAmount: order.discountAmount,
      total: order.total,
      currency: order.currency,
    };
  },
  {
    name: "prepare_payment",
    description:
      "Show the customer a PayPal payment button for the final order amount. Call it once, after the customer confirmed the summary and answered the comment question. The order is NOT placed yet. Returns the total that must be paid.",
    schema: z.object({
      customerNumber: z.string().describe("The verified customer number."),
      comment: z
        .string()
        .optional()
        .describe("The customer's comment exactly as typed. Omit it when the customer gave none."),
      items: orderItemsSchema,
    }),
  }
);

const finalizeOrderTool = tool(
  async (_input, config) => finalizeOrder(config?.configurable?.thread_id),
  {
    name: "finalize_order",
    description:
      "Place the order after the PayPal payment succeeded. Only call it when the system message says the payment was received. Returns the saved order, or an error if the payment is missing.",
    schema: z.object({}),
  }
);

// deepagents always adds a `task` tool with a general-purpose subagent whose prompt is generic and
// does not inherit the ordering guardrails or the payment rules. The subagent also receives every
// tool, including prepare_payment and finalize_order. Replace that subagent with an inert one and
// strip `task` from the model-facing tool list, so customer text cannot escape into an unguarded
// agent that shares the live thread.
const disableTaskDelegation = createMiddleware({
  name: "DisableTaskDelegation",
  wrapModelCall: (request, handler) =>
    handler({ ...request, tools: (request.tools ?? []).filter((tool) => tool.name !== "task") }),
  wrapToolCall: (request, handler) =>
    request.toolCall.name === "task"
      ? {
          content: "Error: task delegation is not available.",
          tool_call_id: request.toolCall.id ?? "",
          name: "task",
          status: "error",
        }
      : handler(request),
});

export const agent = createDeepAgent({
  model: DEFAULT_MODEL,
  systemPrompt: SYSTEM_PROMPT,
  tools: [
    getCurrentTimeTool,
    verifyCustomerNumberTool,
    getCategoriesTool,
    getFlavoursByCategoryTool,
    getCategoriesByFlavourTool,
    getFlavoursByMinPriceTool,
    findFlavourTool,
    calculateOrderTool,
    preparePaymentTool,
    finalizeOrderTool,
  ],
  // Replaces the auto-added general-purpose subagent; without this deepagents injects an unguarded
  // one that inherits all tools. The tool itself is disabled by disableTaskDelegation.
  subagents: [
    {
      name: "general-purpose",
      description: "Not available. Handle the customer's request yourself.",
      systemPrompt: SYSTEM_PROMPT_TEXT,
      tools: [],
    },
  ],
  middleware: [disableTaskDelegation],
  // Keeps the conversation (and the order so far) between chat turns.
  checkpointer: new MemorySaver(),
});

// Usage: pnpm exec tsx spice-anker/agent.ts   (type "exit" to leave)
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const config = { configurable: { thread_id: `anker-${Date.now()}` } };

  const send = async (text) => {
    const result = await agent.invoke(
      { messages: [{ role: "user", content: text }] },
      config
    );
    const content = result.messages[result.messages.length - 1].content;
    const displayContent = Array.isArray(content)
      ? content
          .filter((block) => block?.type === "text")
          .map((block) => block.text)
          .join("") || JSON.stringify(content)
      : typeof content === "string"
        ? content
        : JSON.stringify(content);
    console.log(`\nANKER: ${displayContent}\n`);
  };

  await send("(The customer has just opened the chat. Begin.)");
  while (true) {
    let line;
    try {
      line = (await rl.question("You: ")).trim();
    } catch {
      break;
    }
    if (/^(exit|quit)$/i.test(line)) break;
    if (line) await send(line);
  }
  rl.close();
}
