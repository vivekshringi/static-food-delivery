import { Fragment, useEffect, useRef, useState } from "react";
import { createBasicAuthorization, takeUrlCredentials } from "./orderingAuth.js";

function createThreadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const STATE_KEY = "anker-chat-state";

// Set right before the browser returns from a successful PayPal payment.
function takeReturnState() {
  const url = new URL(window.location.href);
  if (url.searchParams.get("payment") !== "success") return null;
  url.searchParams.delete("payment");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  try {
    const saved = JSON.parse(sessionStorage.getItem(STATE_KEY));
    sessionStorage.removeItem(STATE_KEY);
    return saved?.threadId ? saved : null;
  } catch {
    return null;
  }
}

// Renders **bold** safely as React elements; everything else stays plain text.
function renderMessageText(text) {
  return String(text ?? "")
    .split(/(\*\*[^*\n]+\*\*)/g)
    .map((part, index) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : (
        part
      )
    );
}

function loadPaypalSdk(clientId, currency) {
  if (window.paypal?.Buttons) return Promise.resolve(window.paypal);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture`;
    script.onload = () => resolve(window.paypal);
    script.onerror = () => reject(new Error("PayPal konnte nicht geladen werden."));
    document.head.appendChild(script);
  });
}

function PaypalButton({ payment, authorization, threadId, onPaid, onError }) {
  const containerRef = useRef(null);
  const callbacksRef = useRef({ onPaid, onError });
  callbacksRef.current = { onPaid, onError };

  useEffect(() => {
    let buttons;
    let cancelled = false;
    const headers = { "Content-Type": "application/json", Authorization: authorization };

    async function post(url, body) {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Die Zahlung ist fehlgeschlagen.");
      return result;
    }

    (async () => {
      try {
        const configResponse = await fetch("/api/paypal/config", { headers: { Authorization: authorization } });
        const config = await configResponse.json();
        if (!configResponse.ok) throw new Error(config.error || "PayPal ist nicht verfügbar.");
        const paypal = await loadPaypalSdk(config.clientId, payment.currency);
        if (cancelled || !containerRef.current) return;
        buttons = paypal.Buttons({
          createOrder: async () => (await post("/api/paypal/create-order", { threadId })).id,
          onApprove: async (data) => {
            try {
              await post("/api/paypal/capture-order", { threadId, orderID: data.orderID });
              callbacksRef.current.onPaid();
            } catch (captureError) {
              callbacksRef.current.onError(captureError.message);
            }
          },
          onError: () => callbacksRef.current.onError("Die Zahlung ist fehlgeschlagen. Bitte erneut versuchen."),
        });
        await buttons.render(containerRef.current);
      } catch (sdkError) {
        if (!cancelled) callbacksRef.current.onError(sdkError.message);
      }
    })();

    return () => {
      cancelled = true;
      buttons?.close?.();
    };
  }, [authorization, threadId, payment.currency]);

  return (
    <div className="paypal-box">
      <p>
        Zu zahlen: <strong>{payment.amount.toFixed(2)} {payment.currency}</strong>
      </p>
      <p className="paypal-note">
        Bitte prüfen Sie den Endpreis Ihrer Bestellung auf der PayPal-Zahlungsseite.
      </p>
      <div ref={containerRef} />
    </div>
  );
}

function ChatPage() {
  const [returnState] = useState(takeReturnState);
  const [threadId] = useState(() => returnState?.threadId ?? createThreadId());
  const [credentials, setCredentials] = useState(null);
  const [messages, setMessages] = useState(() => returnState?.messages ?? []);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const transcriptRef = useRef(null);
  const credentialsStartedRef = useRef(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [messages, busy]);

  useEffect(() => {
    if (credentials && !busy) inputRef.current?.focus();
  }, [credentials, busy]);

  useEffect(() => {
    if (credentialsStartedRef.current) return;
    credentialsStartedRef.current = true;

    const urlCredentials = returnState?.credentials ?? takeUrlCredentials();
    if (returnState) {
      setCredentials(urlCredentials);
      setMessages((current) => [
        ...current,
        { id: `${Date.now()}-paid`, role: "bot", text: "Zahlung erfolgreich! Ihre Bestellung wird jetzt bestätigt …" },
      ]);
      sendToAgent({ paymentCompleted: true }, urlCredentials);
      return;
    }
    if (!urlCredentials) {
      setError("Zugangsdaten fehlen. Bitte user und password in der URL angeben.");
      return;
    }
    setCredentials(urlCredentials);
    sendToAgent({ start: true }, urlCredentials);
  }, []);

  async function sendToAgent(payload, activeCredentials) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: createBasicAuthorization(activeCredentials),
        },
        body: JSON.stringify({ threadId, ...payload }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Die Anfrage ist fehlgeschlagen.");
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}-${Math.random()}`,
          role: "bot",
          text: result.reply,
          payment: result.payment ?? null,
        },
      ]);
      return true;
    } catch (requestError) {
      setError(requestError.message || "Verbindungsfehler. Bitte erneut versuchen.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function handlePaid() {
    sessionStorage.setItem(
      STATE_KEY,
      JSON.stringify({
        threadId,
        credentials,
        messages: messages.map(({ payment, ...rest }) => rest),
      })
    );
    window.location.assign("/ordernow?payment=success");
  }

  function focusInput(event) {
    if (event.target.closest("a, button, input, textarea, iframe, .paypal-box")) return;
    if (window.getSelection()?.toString()) return;
    inputRef.current?.focus();
  }

  async function handleMessageSubmit(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !credentials || busy) return;
    setDraft("");
    setMessages((current) => [
      ...current,
      { id: `${Date.now()}-${Math.random()}`, role: "user", text },
    ]);
    await sendToAgent({ message: text }, credentials);
  }

  return (
    <section className="page ordering-page" onClick={focusInput}>
      <header className="ordering-heading">
        <div className="ordering-title">
          <p className="eyebrow">ANKER Bestellung</p>
          <h1>Was darf es sein?</h1>
        </div>
      </header>

      {!credentials ? (
        <p className="chat-access-state" role="status">
          {error || "Chat wird vorbereitet …"}
        </p>
      ) : (
        <div className="chat-workspace">
          <div className="chat-transcript" ref={transcriptRef} aria-live="polite">
            {messages.map((message, index) => (
              <Fragment key={message.id}>
                <p className={`chat-message ${message.role}`}>{renderMessageText(message.text)}</p>
                {message.payment && index === messages.length - 1 ? (
                  <PaypalButton
                    payment={message.payment}
                    authorization={createBasicAuthorization(credentials)}
                    threadId={threadId}
                    onPaid={handlePaid}
                    onError={setError}
                  />
                ) : null}
              </Fragment>
            ))}
            {busy ? <p className="chat-message bot chat-typing">SPICE ANKER schreibt …</p> : null}
          </div>
          {error ? <p className="state-error chat-error" role="alert">{error}</p> : null}
          <form className="chat-composer" onSubmit={handleMessageSubmit}>
            <input
              ref={inputRef}
              aria-label="Nachricht"
              autoComplete="off"
              maxLength={1000}
              placeholder="Nachricht schreiben …"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={busy}
              required
            />
            <button type="submit" disabled={busy || !draft.trim()}>
              Senden
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

export default ChatPage;