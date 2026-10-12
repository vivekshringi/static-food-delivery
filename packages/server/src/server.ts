/* eslint-disable no-console */
import http from "node:http";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import cron from "node-cron";

import { agent } from "../../agent/agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(here, "web");
const ORDERS_FILE = path.join(here, "orders.json");
const BACKUP_FILE = path.join(here, "order.backup.json");

const PORT = Number(process.env.PORT ?? 3100);
// Localhost only by default: the orders page lists every customer's order and has no login.
const HOST = process.env.HOST ?? "127.0.0.1";

const MAX_BODY_BYTES = 10_000;
const MAX_MESSAGE_CHARS = 1000;
const START_MESSAGE_EN =
  "(The customer has just opened the chat. Begin in English.)";
const START_MESSAGE_DE =
  "(The customer has just opened the chat. Begin in German (Deutsch).)";

// German if the highest-weighted Accept-Language entry is de/de-*, otherwise English.
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

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/orders": { file: "orders.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/chat.js": { file: "chat.js", type: "text/javascript; charset=utf-8" },
  "/orders.js": { file: "orders.js", type: "text/javascript; charset=utf-8" },
  "/spice-anker.logo.png": { file: "spice-anker.logo.png", type: "image/png" },
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

type Scope = "chat" | "orders";

const ENV_KEYS: Record<Scope, { user: string; password: string }> = {
  chat: { user: "CHAT_USER", password: "CHAT_PASSWORD" },
  orders: { user: "ORDERS_USER", password: "ORDERS_PASSWORD" },
};

const digest = (value: string) => createHash("sha256").update(value).digest();
const safeEqual = (a: string, b: string) =>
  timingSafeEqual(digest(a), digest(b));

function credentials(scope: Scope) {
  const user = process.env[ENV_KEYS[scope].user];
  const password = process.env[ENV_KEYS[scope].password];
  return user && password ? { user, password } : null;
}

function cookieToken(scope: Scope, user: string, password: string) {
  return createHash("sha256")
    .update(`${scope}\0${user}\0${password}`)
    .digest("hex");
}

function readCookie(req: http.IncomingMessage, name: string): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

// Accepts Basic auth header, a session cookie, or ?user=&password= (which sets the cookie and redirects).
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

const SCOPE_BY_PATH: Record<string, Scope> = {
  "/": "chat",
  "/chat.js": "chat",
  "/api/chat": "chat",
  "/orders": "orders",
  "/orders.js": "orders",
  "/api/orders": "orders",
};

// Moves all current orders to the backup file, then empties orders.json.
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

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body));
}

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

async function readOrders(): Promise<unknown[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(ORDERS_FILE, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

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
