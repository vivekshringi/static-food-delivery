import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, mkdir } from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const storageDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(here, "../server/storage");
export const LOG_DIR = path.join(storageDir, "logs");

const MAX_TEXT = 2000;

function clip(value) {
  if (typeof value === "string") {
    return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…[truncated]` : value;
  }
  if (Array.isArray(value)) return value.map(clip);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)]));
  }
  return value;
}

/**
 * Appends one JSON line to logs/<stream>-YYYY-MM-DD.jsonl (UTC day). Logging never throws, so a
 * full disk or bad path can't break an order.
 *
 * @param stream - "payments" or "conversations"
 */
export async function writeLog(stream, event, data = {}) {
  try {
    const now = new Date();
    await mkdir(LOG_DIR, { recursive: true });
    const line = JSON.stringify({ time: now.toISOString(), event, ...clip(data) });
    await appendFile(
      path.join(LOG_DIR, `${stream}-${now.toISOString().slice(0, 10)}.jsonl`),
      `${line}\n`,
      "utf-8"
    );
  } catch (error) {
    console.error(`[log:${stream}] could not write:`, error.message);
  }
}

export const logPayment = (event, data) => writeLog("payments", event, data);
export const logConversation = (event, data) => writeLog("conversations", event, data);
