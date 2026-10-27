import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";

/**
 * Admin order and payment screen (`/currentOrders`).
 *
 * Reads the admin token from `sessionStorage` itself rather than receiving it as a prop: the token is
 * written after `App` has rendered, so a prop captured there would still be empty on a reload and
 * bounce the admin back to the login.
 *
 * Three sources feed the table: `GET /api/payments` for the full list, an `EventSource` on
 * `/api/admin/orders/stream` for live "new order" notifications, and `GET /api/admin/orders-backup`
 * for the download button. The stream is a trigger, not the source of truth — every event reloads the
 * list so all columns come from the same code path.
 */

const ADMIN_TOKEN_KEY = "adminTokenSessionV1";

/**
 * Formats an amount for the German UI, falling back when the currency code is invalid.
 *
 * @param {number|string} value Amount in the payment record's currency.
 * @param {string} [currency] ISO code; defaults to EUR.
 * @returns {string} Localised currency string, or `"12.50 EUR"` if `Intl` rejects the code.
 */
function formatMoney(value, currency) {
  try {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: currency || "EUR",
    }).format(Number(value) || 0);
  } catch {
    return `${(Number(value) || 0).toFixed(2)} EUR`;
  }
}

/**
 * Formats a timestamp for the German UI.
 *
 * @param {string} value ISO timestamp from the payment record.
 * @returns {string} Localised date/time, or `"Unbekannt"` when the value is missing or invalid.
 */
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unbekannt" : date.toLocaleString("de-DE");
}

/**
 * Lists the dishes of one order with their price and allergens.
 *
 * Keyed by name+category+index because the same dish can legitimately appear twice in an order.
 *
 * @param {{ order: { items?: object[], currency?: string } }} props
 */
function OrderItems({ order }) {
  return (
    <ul className="order-items">
      {(order.items || []).map((item, index) => (
        <li key={`${item.name}-${item.category}-${index}`}>
          <span>{item.name} <span className="order-category">({item.category})</span></span>
          <strong>{formatMoney(item.price, order.currency)}</strong>
          <small>Allergene: {item.allergens?.length ? item.allergens.join(", ") : "keine"}</small>
        </li>
      ))}
    </ul>
  );
}

// Badge text and colour per payment status. `paid` is distinguished from `finalized` because money
// arrived but the agent has not confirmed the order yet — worth a warning rather than a clean tick.
const STATUS_LABELS = {
  finalized: { label: "✔ Bezahlt", tone: "ok" },
  paid: { label: "✔ Bezahlt (Bestellung nicht bestätigt)", tone: "warn" },
  pending: { label: "✖ Nicht bezahlt", tone: "bad" },
};

/**
 * Maps a payment status to its badge.
 *
 * Unknown statuses (including a missing one) fall back to the raw value with the "bad" tone, so a new
 * server-side state is visible instead of silently looking successful.
 *
 * @param {{ status?: string }} payment
 * @returns {{ label: string, tone: "ok"|"warn"|"bad" }}
 */
function statusOf(payment) {
  return STATUS_LABELS[payment.status] || { label: payment.status || "Unbekannt", tone: "bad" };
}

/**
 * Shows a payment's status badge and, behind a disclosure, its PayPal details.
 *
 * Rows with no value are filtered out before rendering, so an unconfigured field does not leave an
 * empty line. Payer email is surfaced outside the disclosure because it identifies the transaction at
 * a glance.
 *
 * @param {{ payment: object }} props Payment record from `/api/payments`.
 */
function PaymentInfo({ payment }) {
  const { label, tone } = statusOf(payment);
  const details = [
    ["Status", payment.status],
    ["Betrag", payment.amount != null ? formatMoney(payment.amount, payment.currency) : ""],
    ["Erstellt am", payment.createdAt ? formatDate(payment.createdAt) : ""],
    ["PayPal-Bestellung", payment.paypalOrderId],
    ["Capture-ID", payment.captureId],
    ["Bezahlt am", payment.paidAt ? formatDate(payment.paidAt) : ""],
    ["Bestätigt am", payment.finalizedAt ? formatDate(payment.finalizedAt) : ""],
    ["Letzter Fehler", payment.lastError],
    ["Fehler am", payment.lastErrorAt ? formatDate(payment.lastErrorAt) : ""],
    ["Chat-Sitzung", payment.sessionId],
  ].filter(([, value]) => value);
  return (
    <>
      <strong className={`payment-status ${tone}`}>{label}</strong>
      {payment.payerEmail ? <><br /><small>{payment.payerEmail}</small></> : null}
      <details className="payment-details">
        <summary>Details</summary>
        <dl>
          {details.map(([detailLabel, value]) => (
            <div key={detailLabel}>
              <dt>{detailLabel}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}

// Table filter options, as [value, label].
const FILTERS = [
  ["all", "Alle"],
  ["paid", "Bezahlt"],
  ["unpaid", "Nicht bezahlt"],
];

/**
 * Whether a payment counts as paid for the filter and the revenue total.
 *
 * Both `finalized` and `paid` mean the money was captured; the difference is only whether the agent
 * has confirmed the order.
 *
 * @param {{ status?: string }} payment
 * @returns {boolean}
 */
function isPaid(payment) {
  return payment.status === "finalized" || payment.status === "paid";
}

/**
 * OrdersPage's root component. See the module comment above for the data sources and the reason the
 * token is read here instead of coming in as a prop.
 */
function OrdersPage() {
  const [token, setToken] = useState(() => sessionStorage.getItem(ADMIN_TOKEN_KEY) || "");
  const [payments, setPayments] = useState([]);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [live, setLive] = useState(false);
  const [newOrders, setNewOrders] = useState([]);
  const authorization = token ? `Bearer ${token}` : "";

  /**
   * Fetches the payment list and replaces the table contents.
   *
   * A 401 means the stored token is no longer valid, so it is removed and the component re-renders
   * into its login redirect instead of repeatedly retrying with a dead token. An explicit
   * authorization can be passed because the SSE effect captures the value it was created with.
   *
   * @param {string} [activeAuthorization] Header value to use; defaults to the current one.
   */
  async function loadPayments(activeAuthorization = authorization) {
    if (!activeAuthorization) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/payments", {
        headers: { Authorization: activeAuthorization },
      });
      if (response.status === 401) {
        // The stored token is no longer accepted: forget it so the login page is shown.
        sessionStorage.removeItem(ADMIN_TOKEN_KEY);
        setToken("");
        return;
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Zahlungen konnten nicht geladen werden.");
      setPayments(Array.isArray(result) ? result : []);
    } catch (loadError) {
      setError(loadError.message || "Verbindungsfehler. Bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Downloads the hourly order backup as a file.
   *
   * Fetched with the auth header rather than linked directly, because a plain `<a href>` cannot send
   * it. The blob is turned into a temporary object URL, clicked programmatically, and revoked so the
   * file is not kept alive in memory.
   */
  async function downloadBackup() {
    setError("");
    try {
      const response = await fetch("/api/admin/orders-backup", {
        headers: { Authorization: authorization },
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Backup konnte nicht geladen werden.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "order.backup.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(downloadError.message || "Backup konnte nicht geladen werden.");
    }
  }

  useEffect(() => {
    if (authorization) loadPayments(authorization);
  }, [authorization]);

  // Subscribes to the server push so a new order appears immediately. EventSource cannot send an
  // Authorization header, so the token goes in the query string; the server checks it before the
  // stream opens. On a drop the browser reconnects by itself and replays missed events.
  useEffect(() => {
    if (!token || typeof EventSource === "undefined") return undefined;
    const source = new EventSource(`/api/admin/orders/stream?token=${encodeURIComponent(token)}`);

    source.addEventListener("ready", () => setLive(true));
    source.addEventListener("order.placed", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      setLive(true);
      setNewOrders((current) => [
        { ...payload.data, receivedAt: new Date().toISOString() },
        ...current.filter((entry) => entry.sessionId !== payload.data?.sessionId),
      ]);
      // Reloads the list so every column (items, status, amount) is filled by the same code path
      // as a manual refresh.
      loadPayments(authorization);
    });
    source.onerror = () => setLive(false);

    return () => source.close();
  }, [token, authorization]);

  if (!token) {
    return <Navigate to="/admin" replace />;
  }

  const sorted = [...payments].sort((first, second) =>
    String(second.time || "").localeCompare(String(first.time || ""))
  );
  const visible = sorted.filter(
    (payment) => filter === "all" || (filter === "paid") === isPaid(payment)
  );
  const paidPayments = payments.filter(isPaid);
  const totalRevenue = paidPayments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const currency = payments[0]?.currency || "EUR";

  return (
    <section className="page ordering-page orders-page">
      <header className="ordering-heading orders-heading">
        <div>
          <p className="eyebrow">Verwaltung</p>
          <h1>Bestellungen und Zahlungen</h1>
        </div>
        <Link className="orders-back" to="/admin/edit">Zurück zur Verwaltung</Link>
      </header>

      {newOrders.length > 0 ? (
        <div className="orders-new-banner" role="status" aria-live="assertive">
          <div>
            <strong>
              {newOrders.length === 1
                ? "1 neue Bestellung eingegangen"
                : `${newOrders.length} neue Bestellungen eingegangen`}
            </strong>
            <span>
              {" "}
              {newOrders[0].customerNumber ? `Kunde ${newOrders[0].customerNumber}` : ""}
              {newOrders[0].total != null
                ? ` · ${formatMoney(newOrders[0].total, newOrders[0].currency)}`
                : ""}
            </span>
          </div>
          <button type="button" onClick={() => setNewOrders([])}>
            Gesehen
          </button>
        </div>
      ) : null}

      <div className="orders-toolbar">
        <p aria-live="polite">
          {payments.length} Vorgang/Vorgänge <span aria-hidden="true">·</span> {paidPayments.length} bezahlt{" "}
          <span aria-hidden="true">·</span> {payments.length - paidPayments.length} nicht bezahlt{" "}
          <span aria-hidden="true">·</span> Umsatz {formatMoney(totalRevenue, currency)}
        </p>
        <label>
          <span className="visually-hidden">Filter</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            {FILTERS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => loadPayments()} disabled={busy || !authorization}>
          {busy ? "Lädt …" : "Aktualisieren"}
        </button>
        <span className={`orders-live ${live ? "on" : "off"}`} title={live ? "Live-Updates aktiv" : "Keine Live-Verbindung"}>
          <span aria-hidden="true">●</span> {live ? "Live" : "Offline"}
        </span>
        <button type="button" onClick={downloadBackup} disabled={!authorization}>
          Backup herunterladen
        </button>
      </div>

      {error ? <p className="state-error" role="alert">{error}</p> : null}
      {!busy && !error && visible.length === 0 ? (
        <p className="orders-empty">Keine Einträge vorhanden.</p>
      ) : null}

      {visible.length > 0 ? (
        <div className="orders-table-wrap">
          <table className="orders-table">
            <thead>
              <tr>
                <th scope="col">Zeit</th>
                <th scope="col">Kunde</th>
                <th scope="col">Artikel</th>
                <th scope="col">Kommentar</th>
                <th scope="col">Zahlung</th>
                <th scope="col">Summe</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((payment) => {
                const order = payment.order || {};
                return (
                  <tr key={payment.sessionId}>
                    <td data-label="Zeit">{payment.time ? formatDate(payment.time) : "–"}</td>
                    <td data-label="Kunde">{String(order.customerNumber || "–")}</td>
                    <td data-label="Artikel"><OrderItems order={order} /></td>
                    <td data-label="Kommentar" className="order-comment">{order.comment || "–"}</td>
                    <td data-label="Zahlung"><PaymentInfo payment={payment} /></td>
                    <td data-label="Summe"><strong>{formatMoney(payment.amount, payment.currency)}</strong></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export default OrdersPage;
