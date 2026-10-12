const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const sendButton = document.getElementById("send");

// getRandomValues also works over plain http on a phone, unlike crypto.randomUUID.
function newThreadId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const threadId = newThreadId();

function addMessage(role, text) {
  const bubble = document.createElement("div");
  bubble.className = `msg ${role}`;
  bubble.textContent = text;
  log.append(bubble);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

function setBusy(busy) {
  input.disabled = busy;
  sendButton.disabled = busy;
  if (!busy) input.focus();
}

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
