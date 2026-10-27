/**
 * Express API server for the Spice Anker single-page app.
 *
 * One process serves the built SPA, the public content/menu endpoints, the ordering chat proxy that
 * talks to the LangGraph agent, the PayPal payment endpoints, and the token-protected admin API.
 *
 * File layout, top to bottom:
 *   1. Configuration constants and file paths
 *   2. Content store (defaults, normalisation, JSON persistence)
 *   3. Transport security (CSP, CORS allowlist, security headers)
 *   4. Authentication helpers and route guards
 *   5. Rate limiting and chat thread ownership
 *   6. Chat turn helpers (prompting, timeout, verification, logging)
 *   7. Order storage and hourly backup
 *   8. Upload handling
 *   9. Middleware wiring and HTTP routes, grouped by audience:
 *      public content, customer ordering, admin API, SPA fallback
 *  10. Background jobs and process bootstrap
 *
 * Anything that only one route needs lives next to that route; the helpers above the routes are
 * shared by more than one of them.
 *
 * Startup writes to `DATA_DIR` (default `packages/server/storage`); the process fails fast if the
 * directory cannot be created, because every content and order route depends on it.
 *
 * @module server/index
 */

import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import cron from 'node-cron';
import {
  agent,
  getMenuForPeriod,
  getCustomerNumbers,
  getPricePeriod,
  saveCustomerNumbers,
  verificationBlocked,
  verifyCustomerNumber,
} from '../../agent/agent.js';
import {
  capturePaypalOrder,
  createPaypalOrder,
  getAllPayments,
  getPayment,
  getPaypalClientId,
  updatePayment,
} from '../../agent/payments.js';
import { logConversation, logPayment } from '../../agent/logger.js';
import { createRateLimiter } from '../../agent/rate-limit.js';
import { withFileLock } from '../../agent/file-lock.js';
import {
  addOrderEventClient,
  eventsSince,
  eventsSinceTime,
  orderEventClientCount,
} from './order-events.js';

// --------------------------------------------------------------------------------------------
// 1. Configuration
// --------------------------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const app = express();
const port = process.env.PORT || 4000;
// Admin routes fail closed: without a configured secret no token is accepted.
const configuredAdminTokenHash =
  process.env.ADMIN_TOKEN_HASH || (process.env.ADMIN_TOKEN ? hashToken(process.env.ADMIN_TOKEN) : null);

const storageDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, '../storage');
const contentFilePath = path.join(storageDir, 'content.json');
const menuFilePath = path.join(storageDir, 'menu.pdf');
const ordersFilePath = path.join(storageDir, 'orders.json');
const ordersBackupFilePath = path.join(storageDir, 'order.backup.json');
const legacyOrdersFilePath = path.resolve(__dirname, '../../agent/orders.json');
const webDistDir = path.resolve(__dirname, '../../web/dist');
const maxChatMessageLength = 1000;
const chatTurnTimeoutMs = Number(process.env.CHAT_TURN_TIMEOUT_MS) || 90 * 1000;

// --------------------------------------------------------------------------------------------
// 2. Content store
// --------------------------------------------------------------------------------------------

// Fallback used when content.json is missing or a field is blank. Every text field the SPA renders
// has a default here, so a half-filled admin form can never publish an empty site.
const defaultContent = {
  restaurantName: 'Spice Anker',
  logoUrl: '/images/spice-anker-logo.png',
  entranceImageUrl: '/images/entrance.png',
  cuisine: 'Authentische indische Kuche',
  description:
    'Willkommen in unserem indischen Restaurant in Hamburg, wo authentische Aromen auf herzliche Gastfreundschaft treffen. Wir servieren köstliche, frisch zubereitete Gerichte, inspiriert von Indiens reicher kulinarischer Kultur, und bieten gleichzeitig Speisen an, die den deutschen Geschmack und die Vorlieben berücksichtigen. Von aromatischen Currys und Tandoori-Spezialitäten bis hin zu ausgewogenen, wohltuenden Gerichten verbindet unsere Speisekarte Tradition, Qualität und ein modernes kulinarisches Erlebnis',
  address: 'Wendenstraße 197\n20537 Hamburg',
  phone: '040/410 99 598',
  mobile: '0176/476 480 78',
  taxId: '',
  timing: 'Mo. - Do. 11:00 - 21:00 Uhr\nFr. 12:00 - 21:00 Uhr\nSa. So. & Feiertage: 12:00 - 21:00 Uhr',
  offers: ['Mittwoch Tandoori Night: 20% auf alle Tandoori-Platten', 'Family Sunday Brunch mit Live-Chaat-Station'],
  social: {
    instagram: 'https://instagram.com/rangmahal.muc',
    facebook: 'https://facebook.com/rangmahal.muc',
  },
  delivery: {
    wolt: 'https://wolt.com',
    lieferando: 'https://www.lieferando.de',
  },
  drinks: {
    fritzKola: 'https://fritz-kola.com/de',
  },
  impressum: {
    ownerName: 'Spice Anker (Inhaber)',
    email: 'info@spiceanker.de',
    managingDirector: '',
    registerCourt: 'Amtsgericht Hamburg',
    registryNumber: '',
    taxNumber: '',
    disputeResolution:
      'Wir sind nicht bereit, an einem Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.',
  },
};

/**
 * Coerces a value to a trimmed string, falling back when it is null/undefined.
 *
 * @param {unknown} value Raw input, usually from the admin form.
 * @param {string} [fallback=''] Value used when `value` is missing.
 * @returns {string} Trimmed string.
 */
function readString(value, fallback = '') {
  if (value === undefined || value === null) {
    return String(fallback).trim();
  }

  return String(value).trim();
}

/**
 * Normalises an admin payload into the exact shape `content.json` is persisted in.
 *
 * Every field is coerced through `readString` (or mapped for arrays), so anything the form omits
 * or whitespace-only falls back to the default instead of blanking the live site. Unknown keys are
 * dropped, which is what keeps stale fields out of the stored file. The three fields the site cannot
 * render without are validated by the PUT route, not here, so internal callers can normalise
 * partial data.
 *
 * @param {object} [payload={}] Raw request body or parsed file contents.
 * @returns {object} Content matching `defaultContent`'s shape.
 */
function normalizeContent(payload = {}) {
  return {
    restaurantName: readString(payload.restaurantName, defaultContent.restaurantName),
    logoUrl: readString(payload.logoUrl, defaultContent.logoUrl),
    entranceImageUrl: readString(payload.entranceImageUrl, defaultContent.entranceImageUrl),
    cuisine: readString(payload.cuisine, defaultContent.cuisine),
    description: readString(payload.description, defaultContent.description),
    address: readString(payload.address, defaultContent.address),
    phone: readString(payload.phone, defaultContent.phone),
    mobile: readString(payload.mobile, defaultContent.mobile),
    taxId: readString(payload.taxId, defaultContent.taxId),
    timing: readString(payload.timing, defaultContent.timing),
    offers: Array.isArray(payload.offers)
      ? payload.offers.map(item => String(item).trim()).filter(Boolean)
      : defaultContent.offers,
    // Dish photos are intentionally absent: the home page showcase is built from
    // `packages/web/assets/dishes-source` by its own script, so they are not editable content and
    // an old `dishImages` key in a stored file is simply dropped here.
    social: {
      instagram: readString(payload.social?.instagram, defaultContent.social.instagram),
      facebook: readString(payload.social?.facebook, defaultContent.social.facebook),
    },
    delivery: {
      wolt: readString(payload.delivery?.wolt, defaultContent.delivery.wolt),
      lieferando: readString(payload.delivery?.lieferando, defaultContent.delivery.lieferando),
    },
    drinks: {
      fritzKola: readString(payload.drinks?.fritzKola, defaultContent.drinks.fritzKola),
    },
    impressum: {
      ownerName: readString(payload.impressum?.ownerName, defaultContent.impressum.ownerName),
      email: readString(payload.impressum?.email, defaultContent.impressum.email),
      managingDirector: readString(
        payload.impressum?.managingDirector,
        defaultContent.impressum.managingDirector
      ),
      registerCourt: readString(payload.impressum?.registerCourt, defaultContent.impressum.registerCourt),
      registryNumber: readString(payload.impressum?.registryNumber, defaultContent.impressum.registryNumber),
      taxNumber: readString(payload.impressum?.taxNumber, defaultContent.impressum.taxNumber),
      disputeResolution: readString(
        payload.impressum?.disputeResolution,
        defaultContent.impressum.disputeResolution
      ),
    },
  };
}

/**
 * Creates the storage directory and seeds content.json on first run. Called once at startup, before
 * any route can read the file.
 */
function ensureStorage() {
  fs.mkdirSync(storageDir, { recursive: true });

  if (!fs.existsSync(contentFilePath)) {
    fs.writeFileSync(contentFilePath, JSON.stringify(defaultContent, null, 2), 'utf-8');
  }
}

/**
 * Reads content.json, normalises it, and decorates it with menu metadata for the SPA.
 *
 * The menu timestamp is derived from menu.pdf at read time so an uploaded menu shows a fresh date
 * without touching content.json. A malformed file throws; the caller decides how to report it.
 *
 * @returns {object} Normalised content plus `menuUrl` and `menuUpdatedAt`.
 */
function readContent() {
  const raw = fs.readFileSync(contentFilePath, 'utf-8');
  const data = normalizeContent(JSON.parse(raw));
  let menuUpdatedAt = null;

  if (fs.existsSync(menuFilePath)) {
    menuUpdatedAt = fs.statSync(menuFilePath).mtime.toISOString();
  }

  return {
    ...data,
    menuUrl: '/menu.pdf',
    menuUpdatedAt,
  };
}

/**
 * Persists normalised content. The caller passes the result of `normalizeContent`, so the file
 * always matches the schema the SPA expects.
 *
 * @param {object} data Normalised content.
 */
function writeContent(data) {
  fs.writeFileSync(contentFilePath, JSON.stringify(data, null, 2), 'utf-8');
}

// --------------------------------------------------------------------------------------------
// 3. Transport security
// --------------------------------------------------------------------------------------------

// Security headers for the SPA. The CSP allowlists only the third parties the app actually loads:
// Google Fonts (styles.css), the PayPal SDK, and Google Maps embeds.
const PAYPAL_ORIGINS = 'https://www.paypal.com https://www.sandbox.paypal.com';
const GOOGLE_FONT_ORIGINS = 'https://fonts.googleapis.com https://fonts.gstatic.com';
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' ${PAYPAL_ORIGINS}`,
  `style-src 'self' 'unsafe-inline' ${GOOGLE_FONT_ORIGINS}`,
  `font-src 'self' ${GOOGLE_FONT_ORIGINS}`,
  `img-src 'self' data: ${PAYPAL_ORIGINS} https://*.google.com https://spice-anker.de`,
  `connect-src 'self' ${PAYPAL_ORIGINS}`,
  `frame-src 'self' ${PAYPAL_ORIGINS} https://www.google.com`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Origins allowed to call the API from a browser. Same-origin requests need no CORS headers, so an
// empty list is the safe default; set CORS_ORIGINS for a separate frontend host.
const allowedCorsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * Sets the CSP and the other hardening headers on every response, including the static SPA.
 *
 * @type {import('express').RequestHandler}
 */
function securityHeaders(_req, res, next) {
  res.set('Content-Security-Policy', contentSecurityPolicy);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
}

// --------------------------------------------------------------------------------------------
// 4. Authentication
// --------------------------------------------------------------------------------------------

/**
 * Hashes a token before it is stored or compared, so the plaintext admin secret never sits in a
 * variable that could be logged or dumped.
 *
 * @param {string} token Plaintext admin token.
 * @returns {string} Lowercase hex SHA-256 digest.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Compares a presented admin token against the configured hash without leaking timing.
 *
 * Fails closed: when no hash is configured nothing is accepted, so a deployment that forgets the
 * secret exposes no admin route instead of an open one.
 *
 * @param {string|null} token Bearer token from the request, if any.
 * @returns {boolean} true only for the exact configured token.
 */
function isTokenValid(token) {
  if (!token || !configuredAdminTokenHash) {
    return false;
  }

  const incoming = hashToken(token);
  const expected = String(configuredAdminTokenHash);

  if (incoming.length !== expected.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(incoming), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Compares two secrets in constant time by hashing both first (equal-length buffers for
 * `timingSafeEqual`, regardless of the inputs' lengths).
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function constantTimeEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left)).digest();
  const rightDigest = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

/**
 * Checks the HTTP Basic credentials the ordering page sends for `/api/chat` and `/api/paypal/*`.
 *
 * @param {import('express').Request} req
 * @param {string} username Expected `CHAT_USER`.
 * @param {string} password Expected `CHAT_PASSWORD`.
 * @returns {boolean}
 */
function basicCredentialsMatch(req, username, password) {
  const authorization = req.get('authorization') || '';
  if (!authorization.startsWith('Basic ')) return false;

  const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  return (
    separator >= 0 &&
    constantTimeEqual(decoded.slice(0, separator), username) &&
    constantTimeEqual(decoded.slice(separator + 1), password)
  );
}

/**
 * Route guard for the admin API. Expects `Authorization: Bearer <token>`.
 *
 * @type {import('express').RequestHandler}
 */
function requireAdminToken(req, res, next) {
  if (!configuredAdminTokenHash) {
    return res.status(503).json({ error: 'Admin authentication is not configured.' });
  }

  const authHeader = req.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;

  if (!isTokenValid(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

/**
 * Route guard for the admin order stream. Accepts the token as a `token` query parameter as well,
 * because EventSource cannot send an Authorization header. Everything else keeps using the header.
 *
 * @type {import('express').RequestHandler}
 */
function requireAdminTokenFromQuery(req, res, next) {
  if (!configuredAdminTokenHash) {
    return res.status(503).json({ error: 'Admin authentication is not configured.' });
  }
  const authHeader = req.get('authorization') || '';
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  if (!isTokenValid(headerToken) && !isTokenValid(queryToken)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

/**
 * Route guard for the customer-facing ordering endpoints. One shared credential gates the chat and
 * the PayPal calls; per-device isolation is handled separately by `claimThread`.
 *
 * @type {import('express').RequestHandler}
 */
function requireChatCredentials(req, res, next) {
  const username = process.env.CHAT_USER;
  const password = process.env.CHAT_PASSWORD;
  if (!username || !password) {
    return res.status(503).json({ error: 'Chat authentication is not configured.' });
  }

  if (basicCredentialsMatch(req, username, password)) return next();

  return res.status(401).json({ error: 'Chat login is required.' });
}

// --------------------------------------------------------------------------------------------
// 5. Rate limiting and thread ownership
// --------------------------------------------------------------------------------------------

// Bounds how fast one client can create new chat threads and new verification attempts. The agent
// counts failed customer-number checks per thread and per client, so without this a caller could
// reset the limit by asking for a fresh threadId. Behind the Fly/production proxy set
// TRUST_PROXY=true, otherwise every request shares the proxy's address and the per-client budget
// would apply globally. The hop count stays at 1 so X-Forwarded-For cannot be spoofed by clients.
const chatRateLimiter = createRateLimiter({
  limit: Number(process.env.CHAT_RATE_LIMIT) || 30,
  windowMs: 60 * 1000,
});
const newThreadRateLimiter = createRateLimiter({
  limit: Number(process.env.CHAT_NEW_THREAD_RATE_LIMIT) || 5,
  windowMs: 60 * 1000,
});
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

/**
 * Client identity used for rate limiting and thread ownership.
 *
 * @param {import('express').Request} req
 * @returns {string} Client IP, or `'unknown'` when Express cannot determine one.
 */
function rateLimitKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Sends the standard 429 payload with a `Retry-After` header.
 *
 * @param {import('express').Response} res
 * @param {number} retryAfterSeconds
 * @returns {import('express').Response}
 */
function tooManyRequests(res, retryAfterSeconds) {
  res.set('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({ error: 'Zu viele Anfragen. Bitte versuche es später erneut.' });
}

// Binds a chat thread to the client that first used it. All customers share one chat credential, so
// without this any holder could append messages to another conversation by supplying its UUID.
// Scope matches the agent's in-memory MemorySaver: a restart drops both, so nothing outlives it.
const threadOwners = new Map();
const MAX_TRACKED_THREADS = 10000;

/**
 * Records `threadId` for `clientKey`, or reports whether this client already owns it.
 *
 * Evicts the oldest entry once `MAX_TRACKED_THREADS` is reached, which is safe because the agent's
 * conversation memory is equally ephemeral.
 *
 * @param {string} threadId Chat thread UUID supplied by the browser.
 * @param {string} clientKey Result of `rateLimitKey`.
 * @returns {boolean} true when the thread is new or owned by this client.
 */
function claimThread(threadId, clientKey) {
  const owner = threadOwners.get(threadId);
  if (owner === undefined) {
    if (threadOwners.size >= MAX_TRACKED_THREADS) {
      threadOwners.delete(threadOwners.keys().next().value);
    }
    threadOwners.set(threadId, clientKey);
    return true;
  }
  return owner === clientKey;
}

// --------------------------------------------------------------------------------------------
// 6. Chat turn helpers
// --------------------------------------------------------------------------------------------

/**
 * Distinguishes a chat-turn timeout from a genuine agent failure.
 *
 * The abort reason is our own Error; LangGraph may also surface an AbortError. Both mean the
 * deadline passed, so the route answers 504 instead of a generic 500.
 *
 * @param {unknown} error Error thrown by `agent.invoke`.
 * @returns {boolean} true when the turn hit the deadline.
 */
function controllerSignalAborted(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  return /timed out/i.test(String(error.message ?? ''));
}

// Injected as the user turn when the browser returns from a completed PayPal flow.
const paymentReceivedMessage =
  '(System: the PayPal payment for this order was received successfully. Call finalize_order now and confirm the order to the customer.)';

/**
 * Flattens a LangChain message payload to plain text.
 *
 * Message content is either a string or an array of content blocks depending on the provider.
 *
 * @param {unknown} content Message content from LangChain.
 * @returns {string} Concatenated text, empty when there is nothing to show.
 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block === 'string' ? block : block?.text || ''))
    .join('');
}

/**
 * Builds the synthetic first user message that opens a chat, in the browser's language.
 *
 * @param {string|undefined} acceptLanguage Raw `Accept-Language` header.
 * @returns {string} Prompt telling the agent to greet in German or English.
 */
function getChatStartMessage(acceptLanguage) {
  const german = String(acceptLanguage || '').toLowerCase().includes('de');
  return german
    ? '(The customer has just opened the chat. Begin in German (Deutsch).)'
    : '(The customer has just opened the chat. Begin in English.)';
}

/**
 * Extracts the customer number that `verify_customer_number` accepted in this turn, so the client
 * can remember it on the device and skip the check on the next visit. Only a successful tool result
 * counts; a number the agent merely echoed back is ignored.
 *
 * @param {Array<object>} messages LangChain messages produced by the turn.
 * @returns {string|null} The verified number, or null when this turn verified nothing.
 */
function verifiedCustomerNumber(messages) {
  const verified = new Map();
  let result = null;
  for (const message of messages) {
    const type = message?.getType?.();
    if (type === 'ai') {
      for (const call of message.tool_calls || []) {
        if (call.name !== 'verify_customer_number') continue;
        const customerNumber = call.args?.customerNumber;
        if (typeof customerNumber === 'string' && customerNumber.trim()) {
          verified.set(call.id, customerNumber.trim());
        }
      }
    } else if (type === 'tool' && message.name === 'verify_customer_number') {
      try {
        const parsed = JSON.parse(contentToText(message.content));
        const customerNumber = verified.get(message.tool_call_id);
        if (parsed?.valid === true && customerNumber) result = customerNumber;
      } catch {
        // An unreadable tool result never confirms a number.
      }
    }
  }
  return result;
}

/**
 * Appends the tool calls, tool results and reply of one chat turn to the conversation log.
 *
 * Only the messages after the newest human message are logged, so replaying a thread does not
 * duplicate earlier turns. Payment state is logged alongside for support cases.
 *
 * @param {string} threadId
 * @param {Array<object>} messages Full message history returned by the agent.
 * @param {object|null} payment Payment record for the thread, if any.
 * @returns {Promise<void>}
 */
async function logAgentTurn(threadId, messages, payment) {
  let start = messages.length - 1;
  while (start > 0 && messages[start]?.getType?.() !== 'human') start -= 1;
  for (const message of messages.slice(start + 1)) {
    const type = message.getType?.();
    if (type === 'ai') {
      for (const call of message.tool_calls || []) {
        await logConversation('tool_call', { threadId, tool: call.name, args: call.args });
      }
      const text = contentToText(message.content);
      if (text) await logConversation('agent_reply', { threadId, text });
    } else if (type === 'tool') {
      await logConversation('tool_result', {
        threadId,
        tool: message.name,
        result: contentToText(message.content),
      });
    }
  }
  if (payment) {
    await logPayment('chat_turn_payment_state', { threadId, status: payment.status, amount: payment.amount });
  }
}

/**
 * Validates the thread id shape the browser generates (a UUID). Rejecting other strings keeps
 * arbitrary keys out of the agent's conversation store and the thread-owner map.
 *
 * @param {unknown} threadId
 * @returns {boolean}
 */
function validThreadId(threadId) {
  return typeof threadId === 'string' && /^[0-9a-f-]{36}$/i.test(threadId);
}

// --------------------------------------------------------------------------------------------
// 7. Order storage
// --------------------------------------------------------------------------------------------

/**
 * Reads a JSON array from disk, treating a missing file as an empty list.
 *
 * @param {string} filePath
 * @returns {Promise<Array<object>>}
 */
async function readOrderFile(filePath) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Moves all current orders to the backup file, then empties orders.json.
 *
 * Uses the same lock as `finalizeOrder`, so an order written during a backup cannot be truncated
 * away. Exported for the hourly cron job and for manual runs.
 *
 * @returns {Promise<number>} How many orders were moved.
 */
export async function backupOrders() {
  return withFileLock('orders', async () => {
    const orders = await readOrderFile(ordersFilePath);
    if (orders.length === 0) return 0;
    const backup = await readOrderFile(ordersBackupFilePath);
    await fs.promises.writeFile(
      ordersBackupFilePath,
      JSON.stringify([...backup, ...orders], null, 2),
      'utf8'
    );
    await fs.promises.writeFile(ordersFilePath, '[]', 'utf8');
    console.log(`[backup] moved ${orders.length} order(s) to ${ordersBackupFilePath}`);
    return orders.length;
  });
}

// --------------------------------------------------------------------------------------------
// 8. Upload handling
// --------------------------------------------------------------------------------------------

// Menu PDFs are held in memory (10 MB cap) and validated by MIME type or `.pdf` extension, because
// browsers disagree about the type they send for a drag-and-dropped file.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdfMime = file.mimetype === 'application/pdf';
    const isPdfName = file.originalname.toLowerCase().endsWith('.pdf');

    if (!isPdfMime && !isPdfName) {
      cb(new Error('Only PDF files are allowed'));
      return;
    }

    cb(null, true);
  },
});

// --------------------------------------------------------------------------------------------
// 9. Middleware wiring and routes
// --------------------------------------------------------------------------------------------

app.use(securityHeaders);
// Same-origin requests send no Origin header and are always allowed. Cross-origin callers must be
// listed in CORS_ORIGINS, so an unknown site cannot read API responses with a user's credentials.
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedCorsOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(webDistDir));

// --------------------------------------------------------------------------------------------
// 9.1. Public content and menus (no credentials)
// --------------------------------------------------------------------------------------------

// Liveness probe for Fly/uptime checks.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Public restaurant content rendered by the SPA and the admin edit form.
app.get('/api/content', (_req, res) => {
  res.json(readContent());
});

// Lunch and dinner menus as served today (no ordering codes), for the printed-menu preview.
app.get('/api/menu', (_req, res) => {
  return res.json({ lunch: getMenuForPeriod('day'), dinner: getMenuForPeriod('evening') });
});

// Full menu for the ordering page: the categories that can be ordered right now with their menu
// codes, plus the period the agent uses, so the page and the chat always show the same dishes.
app.get('/api/order-menu', (_req, res) => {
  return res.json(getMenuForPeriod(getPricePeriod()));
});

// Serves the uploaded menu PDF inline.
app.get('/menu.pdf', (_req, res) => {
  if (!fs.existsSync(menuFilePath)) {
    return res.status(404).send('No menu PDF uploaded yet.');
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename=menu.pdf');
  return res.sendFile(menuFilePath);
});

// --------------------------------------------------------------------------------------------
// 9.2. Customer ordering (chat proxy and PayPal)
// --------------------------------------------------------------------------------------------

// One chat turn. Validates the request, enforces the per-client budgets and the thread ownership
// check, then proxies the message to the LangGraph agent and returns the reply plus any hints the
// page needs (menu card, remembered customer number, pending payment, completed order).
app.post('/api/chat', requireChatCredentials, async (req, res) => {
  const { threadId, message, start, paymentCompleted, customerNumber: storedCustomerNumber } = req.body || {};
  if (!validThreadId(threadId)) {
    return res.status(400).json({ error: 'Ungültige Sitzung.' });
  }

  // Per-client budget for chat turns, plus a tighter budget for first messages that open a new
  // thread. A new thread gets a fresh failed-verification allowance in the agent, so that is the
  // path an attacker would use to walk the customer-number space.
  const clientKey = rateLimitKey(req);
  if (!claimThread(threadId, clientKey)) {
    logConversation('thread_owner_mismatch', { threadId, clientKey });
    return res.status(403).json({ error: 'Diese Sitzung gehört zu einem anderen Gerät.' });
  }
  const chatLimit = chatRateLimiter.hit(clientKey);
  if (!chatLimit.allowed) {
    logConversation('rate_limited', { threadId, scope: 'chat', retryAfterSeconds: chatLimit.retryAfterSeconds });
    return tooManyRequests(res, chatLimit.retryAfterSeconds);
  }
  if (start === true) {
    const newThreadLimit = newThreadRateLimiter.hit(clientKey);
    if (!newThreadLimit.allowed) {
      logConversation('rate_limited', {
        threadId,
        scope: 'new_thread',
        retryAfterSeconds: newThreadLimit.retryAfterSeconds,
      });
      return tooManyRequests(res, newThreadLimit.retryAfterSeconds);
    }
  }
  if (verificationBlocked(threadId, clientKey)) {
    logConversation('verification_locked', { threadId, clientKey });
    return res.status(429).json({ error: 'Zu viele fehlgeschlagene Versuche. Bitte starte einen neuen Chat.' });
  }

  let text = start === true ? getChatStartMessage(req.get('accept-language')) : message;
  // A returning customer sends the number this device remembered. It goes through the same check
  // (and failure budget) as the verify_customer_number tool, and the turn continues with the normal
  // start so the greeting and menu flow stay unchanged.
  let rememberedCustomerNumber = null;
  let rememberedRejected = false;
  if (start === true && typeof storedCustomerNumber === 'string' && storedCustomerNumber.trim()) {
    const verification = verifyCustomerNumber(storedCustomerNumber, { threadId, clientId: clientKey });
    if (verification.valid) {
      rememberedCustomerNumber = storedCustomerNumber.trim();
      text = `${text}\n\n(System: the customer is returning and this device already verified customer number ${rememberedCustomerNumber}. Greet them, show the complete menu with its codes, and continue with ordering. Do not ask for the customer number again.)`;
    } else {
      // The stored number is unknown (or the client is locked). The client forgets it, so the next
      // reload asks again instead of spending another failed attempt.
      rememberedRejected = true;
      logConversation('stored_customer_number_rejected', {
        threadId,
        clientId: clientKey,
        locked: verification.locked === true,
      });
    }
  }
  if (paymentCompleted === true) {
    const payment = await getPayment(threadId);
    if (payment?.status !== 'paid') {
      logPayment('return_without_confirmed_payment', { threadId, status: payment?.status ?? null });
      return res.status(402).json({ error: 'Die Zahlung wurde nicht bestätigt.' });
    }
    logPayment('return_from_paypal', { threadId, paypalOrderId: payment.paypalOrderId });
    text = paymentReceivedMessage;
  }
  if (typeof text !== 'string' || !text.trim() || text.length > maxChatMessageLength) {
    return res.status(400).json({ error: 'Ungültige Nachricht.' });
  }

  logConversation('user_message', {
    threadId,
    source: paymentCompleted === true ? 'system_payment_received' : start === true ? 'start' : 'customer',
    text: text.trim(),
  });

  try {
    // Caps how long one turn can run, so a stuck model call cannot hold the request open or burn
    // budget indefinitely. The signal is honoured by LangGraph and aborts the run.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('chat turn timed out')), chatTurnTimeoutMs);

    let result;
    try {
      result = await agent.invoke(
        { messages: [{ role: 'user', content: text.trim() }] },
        { configurable: { thread_id: threadId, client_id: clientKey }, signal: controller.signal }
      );
    } finally {
      clearTimeout(timeout);
    }

    const lastMessage = result.messages[result.messages.length - 1];
    const payment = await getPayment(threadId);
    await logAgentTurn(threadId, result.messages, payment);
    // A finalized payment means this order is placed: the client ends the visit, so the next
    // reload starts a fresh order and asks for the customer number again.
    const orderPlaced = payment?.status === 'finalized';
    const customerNumber = orderPlaced
      ? null
      : verifiedCustomerNumber(result.messages) ?? rememberedCustomerNumber;
    // The greeting turn also carries the menu, so the page can render it as a card right in the
    // chat instead of relying on the model to print every line. The codes are the ones the agent
    // accepts for ordering.
    const menu = start === true && paymentCompleted !== true ? getMenuForPeriod(getPricePeriod()) : null;
    return res.json({
      reply: contentToText(lastMessage.content),
      ...(menu ? { menu } : {}),
      ...(customerNumber ? { customerNumber } : {}),
      ...(rememberedRejected ? { customerNumberRejected: true } : {}),
      ...(orderPlaced ? { orderPlaced: true } : {}),
      ...(payment?.status === 'pending'
        ? { payment: { amount: payment.amount, currency: payment.currency } }
        : {}),
    });
  } catch (error) {
    const timedOut = controllerSignalAborted(error);
    if (timedOut) {
      logConversation('agent_timeout', { threadId, timeoutMs: chatTurnTimeoutMs });
      return res.status(504).json({ error: 'Die Anfrage hat zu lange gedauert. Bitte versuche es erneut.' });
    }
    console.error('[chat] agent error:', error);
    logConversation('agent_error', { threadId, error: error.message });
    return res.status(500).json({ error: 'Die Nachricht konnte nicht verarbeitet werden.' });
  }
});

app.get('/api/paypal/config', requireChatCredentials, (_req, res) => {
  const clientId = getPaypalClientId();
  if (!clientId) return res.status(503).json({ error: 'PayPal ist nicht konfiguriert.' });
  return res.json({ clientId });
});

// PayPal order id for the pending payment of this thread; the browser SDK uses it to open the
// checkout. The amount always comes from the server-side payment record, never from the client.
app.post('/api/paypal/create-order', requireChatCredentials, async (req, res) => {
  const { threadId } = req.body || {};
  if (!validThreadId(threadId)) {
    return res.status(400).json({ error: 'Ungültige Sitzung.' });
  }
  if (!claimThread(threadId, rateLimitKey(req))) {
    logPayment('thread_owner_mismatch', { threadId, scope: 'create_order' });
    return res.status(403).json({ error: 'Diese Sitzung gehört zu einem anderen Gerät.' });
  }
  try {
    const payment = await getPayment(threadId);
    if (payment?.status !== 'pending') {
      logPayment('create_order_rejected', { threadId, status: payment?.status ?? null });
      return res.status(409).json({ error: 'Keine offene Zahlung.' });
    }
    const paypalOrderId = await createPaypalOrder(threadId, payment);
    logPayment('paypal_order_created', {
      threadId,
      paypalOrderId,
      amount: payment.amount,
      currency: payment.currency,
    });
    await updatePayment(threadId, (current) =>
      current?.status === 'pending' ? { ...current, paypalOrderId } : undefined
    );
    return res.json({ id: paypalOrderId });
  } catch (error) {
    console.error('[paypal] create error:', error);
    logPayment('paypal_order_create_failed', { threadId, error: error.message });
    return res.status(502).json({ error: 'Die Zahlung konnte nicht gestartet werden.' });
  }
});

// Captures the PayPal order after the buyer approves it. Capture is idempotent (an already-paid
// thread returns `ok`) and the captured amount/currency must match the stored payment before the
// thread is marked paid.
app.post('/api/paypal/capture-order', requireChatCredentials, async (req, res) => {
  const { threadId, orderID } = req.body || {};
  if (!validThreadId(threadId) || typeof orderID !== 'string') {
    return res.status(400).json({ error: 'Ungültige Anfrage.' });
  }
  if (!claimThread(threadId, rateLimitKey(req))) {
    logPayment('thread_owner_mismatch', { threadId, scope: 'capture_order' });
    return res.status(403).json({ error: 'Diese Sitzung gehört zu einem anderen Gerät.' });
  }
  try {
    const payment = await getPayment(threadId);
    if (payment?.status === 'paid') return res.json({ ok: true });
    if (payment?.status !== 'pending' || payment.paypalOrderId !== orderID) {
      logPayment('capture_rejected', {
        threadId,
        paypalOrderId: orderID,
        status: payment?.status ?? null,
        expectedPaypalOrderId: payment?.paypalOrderId ?? null,
      });
      return res.status(409).json({ error: 'Keine passende offene Zahlung.' });
    }
    logPayment('capture_started', { threadId, paypalOrderId: orderID });
    const capture = await capturePaypalOrder(orderID);
    const amountMatches =
      Math.round(Number(capture.amount) * 100) === Math.round(payment.amount * 100) &&
      capture.currency === payment.currency;
    if (capture.status !== 'COMPLETED' || capture.captureStatus !== 'COMPLETED' || !amountMatches) {
      logPayment('capture_failed', {
        threadId,
        paypalOrderId: orderID,
        status: capture.status,
        captureStatus: capture.captureStatus,
        captured: `${capture.amount} ${capture.currency}`,
        expected: `${payment.amount} ${payment.currency}`,
      });
      await updatePayment(threadId, (current) => ({
        ...current,
        lastError: `Capture not completed (${capture.status}/${capture.captureStatus}, amount ${capture.amount} ${capture.currency})`,
        lastErrorAt: new Date().toISOString(),
      }));
      return res.status(402).json({ error: 'Die Zahlung wurde nicht abgeschlossen.' });
    }
    await updatePayment(threadId, (current) => ({
      ...current,
      status: 'paid',
      captureId: capture.captureId,
      payerEmail: capture.payerEmail,
      paidAt: new Date().toISOString(),
    }));
    logPayment('payment_captured', {
      threadId,
      paypalOrderId: orderID,
      captureId: capture.captureId,
      payerEmail: capture.payerEmail,
      amount: payment.amount,
      currency: payment.currency,
    });
    return res.json({ ok: true });
  } catch (error) {
    console.error('[paypal] capture error:', error);
    logPayment('capture_error', { threadId, paypalOrderId: orderID, error: error.message });
    await updatePayment(threadId, (current) =>
      current ? { ...current, lastError: error.message, lastErrorAt: new Date().toISOString() } : undefined
    ).catch(() => {});
    return res.status(502).json({ error: 'Die Zahlung konnte nicht bestätigt werden.' });
  }
});

// --------------------------------------------------------------------------------------------
// 9.3. Admin API (Bearer token)
// --------------------------------------------------------------------------------------------

// Downloads the accumulated hourly order backup for the admin screen.
app.get('/api/admin/orders-backup', requireAdminToken, (_req, res) => {
  if (!fs.existsSync(ordersBackupFilePath)) {
    return res.status(404).json({ error: 'Noch kein Backup vorhanden.' });
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="order.backup.json"');
  return res.sendFile(ordersBackupFilePath);
});

// Server-sent events for the admin order screen: a new order is pushed the moment it is placed,
// so the list updates without polling. The token is checked before the stream opens; the browser's
// EventSource cannot send headers, so the page passes it as a query parameter here.
app.get('/api/admin/orders/stream', requireAdminTokenFromQuery, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Replay what the client missed while it was disconnected, then stream live events.
  const lastEventId = Number(req.get('last-event-id') || req.query.lastEventId);
  const missed = Number.isFinite(lastEventId) && lastEventId > 0
    ? eventsSince(lastEventId)
    : eventsSinceTime(req.query.since);
  for (const event of missed) {
    res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.write(`event: ready\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);

  const remove = addOrderEventClient(res);
  console.log('[orders-stream] client connected, total:', orderEventClientCount());

  // Comment frames keep proxies from closing an idle connection.
  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 25 * 1000);

  req.on('close', () => {
    clearInterval(keepAlive);
    remove();
    console.log('[orders-stream] client disconnected, total:', orderEventClientCount());
  });
});

// Payment records for the admin screen, flattened into a list sorted by the caller's own ordering.
app.get('/api/payments', requireAdminToken, async (_req, res) => {
  try {
    const payments = await getAllPayments();
    const list = Object.entries(payments).map(([sessionId, record]) => ({
      sessionId,
      ...record,
      time: record.finalizedAt || record.paidAt || record.createdAt || null,
    }));
    return res.json(list);
  } catch (error) {
    console.error('[payments] read error:', error);
    return res.status(500).json({ error: 'Zahlungen konnten nicht geladen werden.' });
  }
});

// Placed orders for the admin screen. Reads both the current orders.json and the legacy file the
// agent wrote before the storage move, then merges in payment details and de-duplicates by
// customer number + timestamp (falling back to the whole record) so a replayed order appears once.
app.get('/api/orders', requireAdminToken, async (_req, res) => {
  try {
    const [storedOrders, legacyOrders, payments] = await Promise.all([
      readOrderFile(ordersFilePath),
      readOrderFile(legacyOrdersFilePath),
      getAllPayments(),
    ]);
    const paymentsByPaypalId = new Map(
      Object.entries(payments)
        .filter(([, record]) => record?.paypalOrderId)
        .map(([sessionId, record]) => [
          record.paypalOrderId,
          {
            sessionId,
            recordStatus: record.status,
            amount: record.amount,
            currency: record.currency,
            paypalOrderId: record.paypalOrderId,
            captureId: record.captureId,
            payerEmail: record.payerEmail,
            paidAt: record.paidAt,
          },
        ])
    );
    const ordersById = new Map();
    for (const order of [...legacyOrders, ...storedOrders]) {
      if (order?.payment?.status !== 'COMPLETED') continue;
      const id = order?.time
        ? `${order.customerNumber}:${order.time}`
        : JSON.stringify(order);
      const record = paymentsByPaypalId.get(order.payment.paypalOrderId);
      ordersById.set(id, {
        ...order,
        payment: { ...record, ...order.payment, payerEmail: order.payment.payerEmail || record?.payerEmail },
      });
    }
    return res.json([...ordersById.values()]);
  } catch (error) {
    console.error('[orders] read error:', error);
    return res.status(500).json({ error: 'Bestellungen konnten nicht geladen werden.' });
  }
});

// Exchanges an admin token for `{ ok: true }`, used by the admin login form. Unauthenticated by
// design: the token itself is the credential being checked.
app.post('/api/admin/auth', (req, res) => {
  const token = String(req.body?.token || '');
  if (!isTokenValid(token)) {
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }

  return res.json({ ok: true });
});

// Replaces content.json with the admin form's values. Missing fields fall back to the current
// defaults via normalizeContent, and the three fields the site cannot render without are required.
app.put('/api/admin/content', requireAdminToken, (req, res) => {
  const payload = req.body || {};

  const updatedContent = normalizeContent(payload);

  if (!updatedContent.restaurantName || !updatedContent.address || !updatedContent.timing) {
    return res.status(400).json({
      error: 'restaurantName, address and timing are required',
    });
  }

  writeContent(updatedContent);
  return res.json(readContent());
});

// Uploads the printable menu PDF served at /menu.pdf. Validation happens in the multer fileFilter;
// the error handler below turns its rejection into a 400.
app.post('/api/admin/menu', requireAdminToken, upload.single('menu'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Missing PDF file in field 'menu'" });
  }

  fs.writeFileSync(menuFilePath, req.file.buffer);
  return res.json({ ok: true, menuUrl: '/menu.pdf' });
});

// Customer numbers the agent accepts when verifying an order. Both routes are admin-only; the PUT
// replaces the whole list, so the admin screen can edit it as a table.
app.get('/api/admin/customers', requireAdminToken, (_req, res) => {
  try {
    return res.json({ customers: getCustomerNumbers() });
  } catch (error) {
    console.error('[customers] read error:', error);
    return res.status(500).json({ error: 'Kundenliste konnte nicht geladen werden.' });
  }
});

app.put('/api/admin/customers', requireAdminToken, async (req, res) => {
  const { customers } = req.body || {};
  if (!Array.isArray(customers) || customers.length > 10000) {
    return res.status(400).json({ error: 'Ungültige Kundenliste.' });
  }
  try {
    return res.json({ customers: await saveCustomerNumbers(customers) });
  } catch (error) {
    if (error instanceof TypeError) return res.status(400).json({ error: error.message });
    console.error('[customers] write error:', error);
    return res.status(500).json({ error: 'Kundenliste konnte nicht gespeichert werden.' });
  }
});

// --------------------------------------------------------------------------------------------
// 9.4. SPA fallback and error handling
// --------------------------------------------------------------------------------------------

// SPA fallback: unknown API paths must stay 404 JSON instead of being swallowed by the HTML shell,
// so a mistyped fetch fails loudly. Everything else returns index.html for client-side routing.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (fs.existsSync(path.join(webDistDir, 'index.html'))) {
    return res.sendFile(path.join(webDistDir, 'index.html'));
  }

  return res.status(503).send('Web build not found. Run npm run build first.');
});

// Terminal error handler: upload rejections become 400, anything else is logged as a 500 without
// leaking internals to the client.
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message === 'Only PDF files are allowed') {
    return res.status(400).json({ error: err.message });
  }

  return res.status(500).json({ error: 'Unexpected server error' });
});

// --------------------------------------------------------------------------------------------
// 10. Background jobs and bootstrap
// --------------------------------------------------------------------------------------------

// Creates the storage directory and seeds content.json if it is missing. Runs before the cron
// job is scheduled so a backup can never find a half-initialised directory.
ensureStorage();

// Hourly order backup. Runs at minute 5 in the restaurant's timezone so it never straddles midnight.
cron.schedule(
  '5 * * * *',
  () => backupOrders().catch((error) => console.error('[backup] failed:', error)),
  { timezone: process.env.BACKUP_TIMEZONE || 'Europe/Berlin' }
);

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});