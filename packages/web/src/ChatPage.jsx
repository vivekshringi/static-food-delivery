import { Fragment, useEffect, useRef, useState } from "react";
import {
  createBasicAuthorization,
  loadRememberedCredentials,
  rememberCredentials,
  takeUrlCredentials,
} from "./orderingAuth.js";
import {
  loadCustomerNumber,
  saveCustomerNumber,
  clearCustomerNumber,
  clearChatState,
} from "./customerSession.js";

/**
 * Ordering chat page: the customer-facing half of the agent conversation.
 *
 * Flow: credentials come from the URL or the tab's storage → the page opens by sending `start: true`
 * (the server answers with a greeting plus a menu card) → each submit posts one `message` turn →
 * when the reply carries a `payment`, a PayPal button renders inline → after a successful capture the
 * page stores its state and redirects to `?payment=success` → on return it replays with
 * `paymentCompleted: true`, which makes the agent finalize the order.
 *
 * The server is the authority on verification and payment; this component only mirrors state
 * (`customerNumber`, `orderPlaced`, `customerNumberRejected`) into storage so a reload behaves.
 */

/**
 * Generates a v4 UUID for the chat thread.
 *
 * Uses `crypto.getRandomValues` rather than `crypto.randomUUID`, which is unavailable over plain HTTP
 * on a phone, and sets the version/variant nibbles so the server's UUID pattern accepts it.
 *
 * @returns {string} Lowercase UUID; also the agent's conversation key.
 */
function createThreadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const STATE_KEY = "anker-chat-state";

/**
 * Detects the return from a PayPal redirect and restores the conversation that was saved before it.
 *
 * Leaving the page for PayPal destroys the React state, so `handlePaid` writes thread id, credentials
 * and the transcript to `sessionStorage` and redirects to `?payment=success`. This reads that marker,
 * removes both the query parameter and the saved state (so a manual reload cannot replay a payment),
 * and returns the stored transcript.
 *
 * @returns {{ threadId: string, credentials: object, messages: object[] } | null} The saved state, or
 *   `null` for a normal page view.
 */
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

/**
 * Formats a price the German way (`12,50 €`), tolerating string input from JSON.
 */
const euro = (value) => `${Number(value).toFixed(2).replace(".", ",")} €`;

/**
 * Renders the menu the server sends with the greeting as a card inside the chat.
 *
 * Categories carry the menu number, dishes the menu letter, so "1b" is exactly the code the agent
 * accepts. Returning `null` for a missing/empty menu keeps the transcript clean on turns that carry
 * no menu.
 *
 * @param {{ menu: { period?: string, categories?: object[] } | null }} props `menu` as returned by
 *   `/api/chat`.
 */
function MenuCard({ menu }) {
  if (!menu?.categories?.length) return null;
  return (
    <section className="chat-menu" aria-label="Speisekarte">
      <header className="chat-menu-head">
        <h2>Speisekarte</h2>
        <p>
          {menu.period === "day" ? "Mittagskarte (bis 16 Uhr)" : "Abendkarte (ab 16 Uhr)"}
          {" · Bestellen mit Code, z. B. 1b"}
        </p>
      </header>
      <div className="chat-menu-grid">
        {menu.categories.map((category) => (
          <section className="chat-menu-category" key={category.category}>
            <h3>
              <span className="chat-menu-number">{category.number}</span>
              {category.category}
            </h3>
            {category.description ? <p className="chat-menu-description">{category.description}</p> : null}
            <ul>
              {category.flavours.map((flavour) => (
                <li key={flavour.name}>
                  <span className="chat-menu-code">{flavour.code}</span>
                  <span className="chat-menu-flavour">
                    {flavour.name}
                    {flavour.allergens?.length ? <small> ({flavour.allergens.join(", ")})</small> : null}
                  </span>
                  <span className="chat-menu-price">{euro(flavour.price)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}

/**
 * Renders `**bold**` safely as React elements; everything else stays plain text.
 *
 * The split keeps the delimiters as separate parts, so the model's markdown emphasis works without
 * ever injecting HTML (no `dangerouslySetInnerHTML`). The pattern excludes `*` and newlines inside
 * the pair, so an unbalanced `**` cannot swallow the rest of the message.
 *
 * @param {string} text Message text from the agent.
 * @returns {Array<string|import('react').ReactElement>} Parts for React to render.
 */
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

/**
 * Injects the PayPal JS SDK, once per page.
 *
 * Resolves immediately when a previous render already loaded it, which matters because the button is
 * re-created whenever the payment or credentials change. Rejects when the script cannot load, so the
 * caller can show an error instead of an empty box; CSP allows `www.paypal.com` for this.
 *
 * @param {string} clientId PayPal client id from `/api/paypal/config`.
 * @param {string} currency ISO currency code the order is priced in.
 * @returns {Promise<object>} The `window.paypal` object.
 */
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

/**
 * Renders the PayPal checkout for a pending payment and reports the outcome.
 *
 * Three server calls: `config` (client id), `create-order` (PayPal order id for the thread's pending
 * payment) and `capture-order` (after approval). The amount is never sent to PayPal from here — the
 * server derives it from its own payment record and rejects a capture whose amount or currency does
 * not match.
 *
 * Callbacks are held in a ref so a re-render with new closures does not tear down and re-render the
 * PayPal widget. The effect sets `cancelled` on cleanup to avoid rendering into an unmounted
 * container, and closes the previous Buttons instance.
 *
 * @param {object} props
 * @param {{ amount: number, currency: string }} props.payment Pending payment from the chat reply.
 * @param {string} props.authorization Basic auth header value for the customer.
 * @param {string} props.threadId Chat thread the payment belongs to.
 * @param {() => void} props.onPaid Called after the capture succeeds.
 * @param {(message: string) => void} props.onError Called with a user-facing message on any failure.
 */
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

/**
 * ChatPage's root component. See the module comment above for the overall flow.
 *
 * Opening effect, once per mount: when returning from PayPal it replays the payment confirmation;
 * otherwise it sends `start` with any remembered customer number. The `credentialsStartedRef` guard
 * keeps React 18 StrictMode's double-invoked effect from sending the greeting twice.
 */
function ChatPage() {
  const [returnState] = useState(takeReturnState);
  const [threadId, setThreadId] = useState(() => returnState?.threadId ?? createThreadId());
  const [credentials, setCredentials] = useState(null);
  const [messages, setMessages] = useState(() => returnState?.messages ?? []);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const transcriptRef = useRef(null);
  const credentialsStartedRef = useRef(false);
  const inputRef = useRef(null);
  const orderFinishedRef = useRef(false);

  // Follows the conversation: after the first reply (the greeting with the menu) the page stays at
  // the top so the menu is readable, and later turns bring the newest message into view.
  useEffect(() => {
    if (messages.length === 0) return;
    const last = transcriptRef.current?.lastElementChild;
    last?.scrollIntoView({ block: "nearest", behavior: messages.length > 1 ? "smooth" : "auto" });
  }, [messages, busy]);

  useEffect(() => {
    if (credentials && !busy) inputRef.current?.focus();
  }, [credentials, busy]);

  useEffect(() => {
    if (credentialsStartedRef.current) return;
    credentialsStartedRef.current = true;

    const urlCredentials = returnState?.credentials ?? takeUrlCredentials() ?? loadRememberedCredentials();
    if (returnState) {
      setCredentials(urlCredentials);
      rememberCredentials(urlCredentials);
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
    rememberCredentials(urlCredentials);
    sendToAgent({ start: true, customerNumber: loadCustomerNumber() || undefined }, urlCredentials);
  }, []);

  /**
   * Posts one turn to `/api/chat` and appends the reply to the transcript.
   *
   * Applies the hints the server returns: a rejected remembered number is forgotten, a verified one is
   * stored, and `orderPlaced` ends the visit (so a reload starts a fresh order). Errors are shown in
   * the banner but do not remove the customer's draft, and the boolean result lets the caller chain a
   * follow-up step only on success.
   *
   * @param {object} payload Extra request fields (`start`, `message`, `paymentCompleted`,
   *   `customerNumber`).
   * @param {{ username: string, password: string }} activeCredentials Credentials for this request.
   * @param {string} [activeThreadId] Thread to continue; defaults to the current one and is passed
   *   explicitly when `handleNewOrder` has just created a new id before state settles.
   * @returns {Promise<boolean>} true when the turn succeeded.
   */
  async function sendToAgent(payload, activeCredentials, activeThreadId = threadId) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: createBasicAuthorization(activeCredentials),
        },
        body: JSON.stringify({ threadId: activeThreadId, ...payload }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Die Anfrage ist fehlgeschlagen.");
      if (result.customerNumberRejected === true) {
        clearCustomerNumber();
      }
      if (result.orderPlaced === true) {
        // The order is finished, so this visit is over: a reload starts a new order and asks for
        // the customer number again.
        orderFinishedRef.current = true;
        clearChatState();
      } else if (result.customerNumber) {
        saveCustomerNumber(result.customerNumber);
      }
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}-${Math.random()}`,
          role: "bot",
          text: result.reply,
          payment: result.payment ?? null,
          menu: result.menu ?? null,
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

  /**
   * Persists the conversation and leaves for PayPal's return URL.
   *
   * PayPal navigates the whole page away, so the transcript, thread id and credentials go to
   * `sessionStorage` first. Pending payment objects are stripped from the saved messages: an unpaid
   * button must not reappear after the return, where `takeReturnState` resumes the flow instead.
   */
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

  /**
   * Starts a new order in the same tab after one has been completed.
   *
   * Forgets the verified number (so it is asked again), clears the transcript, and opens a fresh
   * thread. The new thread id is passed to `sendToAgent` explicitly because the state update has not
   * been applied yet when the greeting request fires.
   */
  function handleNewOrder() {
    clearChatState();
    setMessages([]);
    setError("");
    orderFinishedRef.current = false;
    const nextThreadId = createThreadId();
    setThreadId(nextThreadId);
    if (credentials) sendToAgent({ start: true }, credentials, nextThreadId);
  }

  /**
   * Puts the cursor back in the composer when the customer clicks empty space in the chat.
   *
   * Skips interactive elements (so links, the PayPal widget and form fields keep their normal
   * behaviour) and skips while text is selected, which would otherwise clear the selection.
   */
  function focusInput(event) {
    if (event.target.closest("a, button, input, textarea, iframe, .paypal-box")) return;
    if (window.getSelection()?.toString()) return;
    inputRef.current?.focus();
  }

  /**
   * Sends the typed message as one chat turn.
   *
   * Clears the draft optimistically and echoes the message locally before awaiting the reply, so the
   * transcript keeps the customer's own words even if the request fails.
   */
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
        <>
          <div className="chat-workspace">
            <div className="chat-transcript" ref={transcriptRef} aria-live="polite">
              {messages.map((message, index) => (
                <Fragment key={message.id}>
                  <p className={`chat-message ${message.role}`}>{renderMessageText(message.text)}</p>
                  {message.menu ? <MenuCard menu={message.menu} /> : null}
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
              {orderFinishedRef.current ? (
                <div className="chat-new-order">
                  <p>Ihre Bestellung ist abgeschlossen.</p>
                  <button type="button" onClick={handleNewOrder} disabled={busy}>
                    Neue Bestellung
                  </button>
                </div>
              ) : null}
            </div>
            {error ? <p className="state-error chat-error" role="alert">{error}</p> : null}
            {orderFinishedRef.current ? null : (
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
            )}
          </div>
        </>
      )}
    </section>
  );
}

export default ChatPage;