/**
 * Legacy vanilla chat client for the standalone `index.html` page.
 *
 * Superseded by `ChatPage.jsx` in the React SPA (which is what `index.html` at the package root loads).
 * This script is only used by `src/index.html`, served by the unused `server.ts`. It talks to the plain
 * `/api/chat` contract with no auth header, no customer-number memory and no PayPal.
 */

const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const sendButton = document.getElementById("send");

/**
 * Generates a v4 UUID for the chat thread.
 *
 * Uses `crypto.getRandomValues` rather than `crypto.randomUUID`, which is unavailable over plain HTTP
 * on a phone, and sets the version/variant nibbles so the server's UUID check accepts it.
 *
 * @returns {string} Lowercase UUID.
 */
function newThreadId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// One thread for the lifetime of the page.
const threadId = newThreadId();

/**
 * Appends a message bubble and scrolls it into view.
 *
 * @param {string} role CSS role suffixes, e.g. `"bot"`, `"user"` or `"bot typing"`.
 * @param {string} text Plain text; set via `textContent` so a model reply cannot inject markup.
 * @returns {HTMLDivElement} The appended bubble, so the caller can remove it again.
 */
function addMessage(role, text) {
  const bubble = document.createElement("div");
  bubble.className = `msg ${role}`;
  bubble.textContent = text;
  log.append(bubble);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

/**
 * Locks the composer while a turn is in flight and restores focus afterwards.
 *
 * Disabling the input and button (rather than ignoring a second submit) is what prevents two
 * concurrent turns on the same thread, which the agent cannot interleave.
 *
 * @param {boolean} busy
 */
function setBusy(busy) {
  input.disabled = busy;
  sendButton.disabled = busy;
  if (!busy) input.focus();
}

/**
 * Posts one turn to `/api/chat` and renders the reply.
 *
 * Shows a temporary "typing" bubble that is removed on every exit path (success, error, network
 * failure), so the transcript never keeps a stuck placeholder. Failures render a generic message rather
 * than the raw error, since this page has no auth or payment context to explain.
 *
 * @param {object} payload Extra request fields (`start` or `message`), merged with the thread id.
 */
async function send(payload) {
  setBusy(true);
  const typing = addMessage("bot typing", "…");
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, ...payload }),
    });
    const data = await response.json();
    typing.remove();
    if (!response.ok) throw new Error(data.error || "Fehler");
    addMessage("bot", data.reply);
  } catch {
    typing.remove();
    addMessage("error", "Verbindungsfehler. Bitte versuchen Sie es erneut.");
  } finally {
    setBusy(false);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  addMessage("user", text);
  send({ message: text });
});

send({ start: true });
