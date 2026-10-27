/* eslint-disable no-console */
/**
 * Legacy standalone ordering server (plain `node:http`, no Express).
 *
 * Superseded by `index.js`, which is what `npm start` runs and what serves the SPA, the chat proxy,
 * the PayPal flow and the admin API. This module is kept for reference and for the small
 * deployments that only need the two original pages (`index.html` chat and `orders.html` list) plus
 * the two JSON endpoints below. Nothing in the repo imports it, and `package.json` does not run it.
 *
 * Scope compared to `index.js`:
 *   - Static pages/scripts are served from `src/web`, not the built SPA in `packages/web/dist`.
 *   - There is no PayPal integration, no order events/SSE, and no admin content editing.
 *   - It adds cookie-based sessions (`anker_chat`, `anker_orders`) on top of Basic auth, which
 *     `index.js` does not have.
 *   - Orders are stored in `src/orders.json` next to this file, not under `storage/`.
 *
 * Auth: two independent scopes, each gated by a username/password pair from the environment
 * (`CHAT_USER`/`CHAT_PASSWORD`, `ORDERS_USER`/`ORDERS_PASSWORD`). Requests may present the
 * credential three ways: an `Authorization: Basic` header, the session cookie, or `?user=&password=`
 * query parameters (which set the cookie and redirect so the secret leaves the address bar).
 *
 * Routing: every request passes through `authorize` first when its path appears in `SCOPE_BY_PATH`.
 * Paths not listed there (the shared CSS/logo, `/api/health` if added later) are public.
 *
 * @module server/server
 */

import http from "node:http";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import cron from "node-cron";

import { agent } from "../../agent/agent.js";

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

// Directory holding the static pages and scripts this server serves.
const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(here, "web");
// Live orders and the hourly-rotated archive; both are JSON arrays of order records.
const ORDERS_FILE = path.join(here, "orders.json");
const BACKUP_FILE = path.join(here, "order.backup.json");

const PORT = Number(process.env.PORT ?? 3100);
// Localhost only by default: the orders page lists every customer's order and has no login.
// Set HOST=0.0.0.0 in the environment to expose it, but only behind an authenticating proxy.
const HOST = process.env.HOST ?? "127.0.0.1";

// Rejects oversized chat payloads before they reach the agent (and before the body is buffered).
const MAX_BODY_BYTES = 10_000;
const MAX_MESSAGE_CHARS = 1000;
// Injected as the first user turn so the agent greets in the browser's language.
const START_MESSAGE_EN =
  "(The customer has just opened the chat. Begin in English.)";
const START_MESSAGE_DE =
  "(The customer has just opened the chat. Begin in German (Deutsch).)";

/**
 * Picks the greeting language from the `Accept-Language` header.
 *
 * Parses the weighted list properly instead of testing for a substring: `de-AT;q=0.9, en;q=0.8`
 * selects German, `en-US,en;q=0.9,de;q=0.1` selects English, and a `de;q=0` entry (explicit refusal) is
 * filtered out. Falls back to English when the header is missing, empty, or lists only wildcards.
 *
 * @param header Raw `Accept-Language` request header.
 * @returns The German or English start prompt for the highest-weighted supported language.
 */
function startMessage(header: string | undefined): string {
  const best = (header ?? "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      const weight = q ? Number(q.trim().slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), weight };
    })
    .filter((e) => e.tag && e.tag !== "*" && e.weight > 0)
    .sort((a, b) => b.weight - a.weight)[0];
  const german = best && (best.tag === "de" || best.tag.startsWith("de-"));
  return german ? START_MESSAGE_DE : START_MESSAGE_EN;
}

// ---------------------------------------------------------------------------------------------
// Static files and response headers
// ---------------------------------------------------------------------------------------------

// Allowlist rather than a directory handler: only these paths are served, each with a pinned
// Content-Type, so a request cannot walk out of WEB_DIR or get a browser-sniffed MIME type.
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/orders": { file: "orders.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/chat.js": { file: "chat.js", type: "text/javascript; charset=utf-8" },
  "/orders.js": { file: "orders.js", type: "text/javascript; charset=utf-8" },
  "/spice-anker.logo.png": { file: "spice-anker.logo.png", type: "image/png" },
};

// Applied to every response, including redirects, errors and static files. No third-party origins
// are needed here because these pages load nothing external.
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

// ---------------------------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------------------------

// Two independent credentials: the chat page/API and the orders page/API. A customer who is given
// the chat login therefore cannot read the order list.
type Scope = "chat" | "orders";

// Environment variable names holding each scope's username and password.
const ENV_KEYS: Record<Scope, { user: string; password: string }> = {
  chat: { user: "CHAT_USER", password: "CHAT_PASSWORD" },
  orders: { user: "ORDERS_USER", password: "ORDERS_PASSWORD" },
};

/**
 * SHA-256 digest of a value.
 *
 * Hashing before comparison gives `timingSafeEqual` two equal-length buffers, so the secret's length
 * is not leaked through an exception or an early return.
 */
const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Compares two strings in constant time (with respect to their contents).
 *
 * @returns true when the values match.
 */
const safeEqual = (a: string, b: string) =>
  timingSafeEqual(digest(a), digest(b));

/**
 * Reads a scope's credentials from the environment.
 *
 * @returns The configured pair, or `null` when either variable is missing. Callers treat `null` as
 *   "not configured" and refuse the request (503) rather than allowing it.
 */
function credentials(scope: Scope) {
  const user = process.env[ENV_KEYS[scope].user];
  const password = process.env[ENV_KEYS[scope].password];
  return user && password ? { user, password } : null;
}

/**
 * Derives the session-cookie value for a scope.
 *
 * The cookie stores a hash of scope + username + password rather than the password itself, so the
 * browser never holds the secret. Rotating the password invalidates every existing cookie, because
 * the token changes with it. The NUL separators keep `ab`/`c` from colliding with `a`/`bc`.
 *
 * @returns Hex SHA-256 token to put in `anker_<scope>`.
 */
function cookieToken(scope: Scope, user: string, password: string) {
  return createHash("sha256")
    .update(`${scope}\0${user}\0${password}`)
    .digest("hex");
}

/**
 * Reads one cookie from the request.
 *
 * Splits on `=` with a limit so values containing `=` (common in base64 payloads) survive intact.
 *
 * @param name Cookie name, for example `anker_chat`.
 * @returns The raw cookie value, or `""` when the cookie is absent.
 */
function readCookie(req: http.IncomingMessage, name: string): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

/**
 * Gate for every protected path. Returns `true` only when the request may proceed; on failure it has
 * already written the response, so the caller must return immediately.
 *
 * Three ways in, checked in order of cheapness:
 *   1. Session cookie — a hash of scope+user+password, so repeat visits skip the browser prompt.
 *   2. `Authorization: Basic` — what the browser sends after a 401 challenge, and what scripts use.
 *   3. `?user=&password=` — for a link the browser cannot prompt for. On success the credentials are
 *      stripped from the URL, the cookie is set, and the browser is redirected (302) so the secret
 *      does not stay in the address bar or in history.
 *
 * Every comparison goes through `safeEqual`. A missing configuration answers 503 rather than 401, so
 * a deployment mistake is distinguishable from a wrong password; an unauthenticated request gets a
 * 401 with a Basic challenge, which makes browsers show their login dialog.
 *
 * @param req Incoming request; the cookie and authorization header are read from it.
 * @param res Response used to write the 302/401/503 on failure.
 * @param url Request URL; query credentials are consumed and stripped from it.
 * @param scope Which credential pair protects this path.
 * @returns true when access is granted; false when a response has already been sent.
 */
function authorize(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  scope: Scope
): boolean {
  const expected = credentials(scope);
  if (!expected) {
    sendJson(res, 503, { error: "Authentication is not configured." });
    return false;
  }
  const token = cookieToken(scope, expected.user, expected.password);
  const match = (user: string, password: string) =>
    safeEqual(user, expected.user) && safeEqual(password, expected.password);

  if (safeEqual(readCookie(req, `anker_${scope}`), token)) return true;

  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    const i = decoded.indexOf(":");
    if (i >= 0 && match(decoded.slice(0, i), decoded.slice(i + 1))) return true;
  }

  const qUser = url.searchParams.get("user");
  const qPassword = url.searchParams.get("password");
  if (qUser !== null && qPassword !== null && match(qUser, qPassword)) {
    url.searchParams.delete("user");
    url.searchParams.delete("password");
    const query = url.searchParams.toString();
    res.writeHead(302, {
      ...SECURITY_HEADERS,
      "Set-Cookie": `anker_${scope}=${token}; Path=/; HttpOnly; SameSite=Strict`,
      Location: url.pathname + (query ? `?${query}` : ""),
    });
    res.end();
    return false;
  }

  res.writeHead(401, {
    ...SECURITY_HEADERS,
    "WWW-Authenticate": `Basic realm="ANKER ${scope}", charset="UTF-8"`,
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("Authentication required.");
  return false;
}

// Which credential protects which path. Paths absent from this map (style.css, the logo) are public,
// so both pages can load their shared assets before the browser has authenticated.
const SCOPE_BY_PATH: Record<string, Scope> = {
  "/": "chat",
  "/chat.js": "chat",
  "/api/chat": "chat",
  "/orders": "orders",
  "/orders.js": "orders",
  "/api/orders": "orders",
};

// ---------------------------------------------------------------------------------------------
// Order storage
// ---------------------------------------------------------------------------------------------

/**
 * Moves all current orders to the backup file, then empties orders.json.
 *
 * Appends to the existing archive so nothing is lost across runs; a missing or unparsable archive is
 * treated as empty rather than aborting, except for real I/O errors, which propagate. Unlike
 * `index.js`, this version does not take the shared file lock, so it must not run alongside a writer.
 *
 * @returns Resolves after both files are written, or immediately when there is nothing to move.
 */
export async function backupOrders() {
  const orders = await readOrders();
  if (orders.length === 0) return;
  let backup: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(await readFile(BACKUP_FILE, "utf-8"));
    if (Array.isArray(parsed)) backup = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(
    BACKUP_FILE,
    JSON.stringify([...backup, ...orders], null, 2),
    "utf-8"
  );
  await writeFile(ORDERS_FILE, "[]", "utf-8");
  console.log(`[backup] moved ${orders.length} order(s) to ${BACKUP_FILE}`);
}

// ---------------------------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------------------------

/**
 * Writes a JSON response with the hardened header set.
 *
 * Centralised so every JSON reply, including auth failures, carries the same security headers and
 * `Content-Type` instead of relying on each call site.
 *
 * @param res
 * @param status HTTP status code.
 * @param body Value to serialise as the JSON body.
 */
function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body));
}

/**
 * Buffers the request body as UTF-8 text, refusing anything over `MAX_BODY_BYTES`.
 *
 * The limit is enforced while streaming rather than after the fact, so an oversized upload is
 * rejected before it is fully in memory. Throws `"Request body too large."`, which the chat handler
 * reports as a 400 and the outer handler as a 500.
 *
 * @param req
 * @returns The complete body as a string.
 */
async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Flattens a LangChain message payload to plain text.
 *
 * Content is a string for some providers and an array of content blocks for others; blocks may
 * themselves be strings or objects with a `text` field. Anything else contributes nothing.
 *
 * @param content Message content from the agent result.
 * @returns Concatenated text, or `""` when there is nothing to show.
 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "string"
          ? block
          : ((block as { text?: string }).text ?? "")
      )
      .join("");
  }
  return "";
}

/**
 * Reads the order list from disk.
 *
 * A missing file is a normal first-run state and yields `[]`; any other error (bad JSON, permissions)
 * propagates so the caller can answer 500 rather than silently reporting "no orders".
 *
 * @returns The stored orders, or an empty list when the file does not exist yet.
 */
async function readOrders(): Promise<unknown[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(ORDERS_FILE, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------------------------

/**
 * `POST /api/chat` — runs one turn against the LangGraph agent and returns its reply.
 *
 * Validates before touching the agent: the body must parse, `threadId` must look like a UUID (keeps
 * arbitrary keys out of the agent's conversation store), and the message must be non-empty and within
 * `MAX_MESSAGE_CHARS`. When `start` is true the client message is replaced by the localized greeting
 * prompt, so the page can open a conversation without inventing text.
 *
 * Only the reply text is returned; unlike `index.js` there is no menu card, cached customer number or
 * payment status. Agent failures are logged and answered with a generic 500 so internals are not
 * leaked to the browser.
 */
async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  let payload: { threadId?: unknown; message?: unknown; start?: unknown };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid request." });
  }

  const { threadId, message, start } = payload;
  if (typeof threadId !== "string" || !/^[0-9a-f-]{36}$/i.test(threadId)) {
    return sendJson(res, 400, { error: "Invalid session." });
  }
  const text =
    start === true ? startMessage(req.headers["accept-language"]) : message;
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > MAX_MESSAGE_CHARS
  ) {
    return sendJson(res, 400, { error: "Invalid message." });
  }

  try {
    const result = await agent.invoke(
      { messages: [{ role: "user", content: text.trim() }] },
      { configurable: { thread_id: threadId } }
    );
    const last = result.messages[result.messages.length - 1];
    return sendJson(res, 200, { reply: contentToText(last.content) });
  } catch (error) {
    console.error("[chat] agent error:", error);
    return sendJson(res, 500, { error: "Something went wrong." });
  }
}

/**
 * The HTTP server instance, exported so tests can `listen` on an ephemeral port and so embedding
 * code can mount it. Constructing it has no side effects; listening and the cron job happen only in
 * the bootstrap block at the bottom, which runs exclusively when this file is the process entry
 * point.
 *
 * Routing, in order: scope gate (401/302/503 as needed) → `POST /api/chat` → `GET /api/orders` →
 * static allowlist → 404. Any error thrown by a handler becomes a logged 500, so an agent failure or
 * a missing file cannot crash the process or leave the socket hanging.
 */
export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  try {
    const scope = SCOPE_BY_PATH[url.pathname];
    if (scope && !authorize(req, res, url, scope)) return;

    if (req.method === "POST" && url.pathname === "/api/chat") {
      return await handleChat(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/orders") {
      return sendJson(res, 200, await readOrders());
    }
    if (req.method === "GET" && STATIC_FILES[url.pathname]) {
      const { file, type } = STATIC_FILES[url.pathname];
      const body = await readFile(path.join(WEB_DIR, file));
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type });
      return res.end(body);
    }
    return sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    console.error("[server] error:", error);
    return sendJson(res, 500, { error: "Something went wrong." });
  }
});

// Runs only when this module is executed directly (`node src/server.ts`), not when it is imported, so
// tests can import `server` and `backupOrders` without binding a port or scheduling a job.
//
// The backup fires at midnight in the restaurant's timezone, matching the daily rotation this
// cut-down server was built around (`index.js` uses an hourly schedule instead).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  cron.schedule(
    "0 0 * * *",
    () => backupOrders().catch((e) => console.error("[backup] failed:", e)),
    { timezone: process.env.BACKUP_TIMEZONE ?? "Europe/Berlin" }
  );
  server.listen(PORT, HOST, () => {
    console.log(`ANKER ordering: http://${HOST}:${PORT}  |  orders: http://${HOST}:${PORT}/orders`);
  });
}
