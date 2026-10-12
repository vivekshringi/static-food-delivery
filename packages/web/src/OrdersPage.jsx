import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";

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

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unbekannt" : date.toLocaleString("de-DE");
}

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

const STATUS_LABELS = {
  finalized: { label: "✔ Bezahlt", tone: "ok" },
  paid: { label: "✔ Bezahlt (Bestellung nicht bestätigt)", tone: "warn" },
  pending: { label: "✖ Nicht bezahlt", tone: "bad" },
};

function statusOf(payment) {
  return STATUS_LABELS[payment.status] || { label: payment.status || "Unbekannt", tone: "bad" };
}

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

const FILTERS = [
  ["all", "Alle"],
  ["paid", "Bezahlt"],
  ["unpaid", "Nicht bezahlt"],
];

function isPaid(payment) {
  return payment.status === "finalized" || payment.status === "paid";
}

function OrdersPage({ token }) {
  const [payments, setPayments] = useState([]);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const authorization = token ? `Bearer ${token}` : "";

  async function loadPayments(activeAuthorization = authorization) {
    if (!activeAuthorization) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/payments", {
        headers: { Authorization: activeAuthorization },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Zahlungen konnten nicht geladen werden.");
      setPayments(Array.isArray(result) ? result : []);
    } catch (loadError) {
      setError(loadError.message || "Verbindungsfehler. Bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

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
