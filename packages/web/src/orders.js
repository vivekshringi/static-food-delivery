/**
 * Legacy admin order table for the standalone `orders.html` page.
 *
 * Superseded by `OrdersPage.jsx` in the React SPA. Used only by `src/orders.html`, served by the unused
 * `server.ts`, so it has no auth header, no live stream and no filters: it loads `/api/orders` and
 * renders a table.
 */

const rows = document.getElementById("rows");
const table = document.getElementById("table");
const empty = document.getElementById("empty");
const stats = document.getElementById("stats");
const refresh = document.getElementById("refresh");

/** Formats an amount in German locale, defaulting to EUR when the order has no currency. */
const money = (value, currency) =>
  new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: currency || "EUR",
  }).format(value);

/**
 * Builds a table cell, keeping the column label in `data-label` for the responsive stacked layout.
 *
 * @param {string} label Column name, surfaced as `data-label` for narrow screens.
 * @param {string|Node} content Cell text, or a node to append (e.g. the item list).
 * @returns {HTMLTableCellElement}
 */
function cell(label, content) {
  const td = document.createElement("td");
  td.dataset.label = label;
  if (typeof content === "string") td.textContent = content;
  else td.append(content);
  return td;
}

/**
 * Builds the `<ul>` of dishes for one order row.
 *
 * @param {{ items?: object[], currency?: string }} order
 * @returns {HTMLUListElement} List with name, category, price and allergens per dish.
 */
function itemsList(order) {
  const list = document.createElement("ul");
  list.className = "items";
  for (const item of order.items ?? []) {
    const li = document.createElement("li");

    const line = document.createElement("span");
    line.textContent = `${item.name} (${item.category}) – ${money(item.price, order.currency)}`;
    li.append(line);

    const allergens = document.createElement("small");
    allergens.textContent = `Allergene: ${item.allergens?.length ? item.allergens.join(", ") : "keine"}`;
    li.append(document.createElement("br"), allergens);

    list.append(li);
  }
  return list;
}

/**
 * Re-renders the table from a fresh order list.
 *
 * Sorts newest first by `time` string comparison (ISO timestamps sort lexicographically), rebuilds the
 * body with `replaceChildren` so no stale rows survive, and toggles the table/empty-state pair. The
 * revenue total uses the first order's currency, which is correct here because the server only ever
 * produces EUR orders.
 *
 * @param {object[]} orders Order records from `/api/orders`.
 */
function render(orders) {
  rows.replaceChildren();
  const sorted = [...orders].sort((a, b) => String(b.time).localeCompare(String(a.time)));

  for (const order of sorted) {
    const tr = document.createElement("tr");
    tr.append(
      cell("Zeit", new Date(order.time).toLocaleString("de-DE")),
      cell("Kunde", String(order.customerNumber)),
      cell("Artikel", itemsList(order)),
      cell("Kommentar", order.comment ? String(order.comment) : "–"),
      cell("Summe", money(order.total, order.currency))
    );
    rows.append(tr);
  }

  const revenue = orders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  stats.textContent = `${orders.length} Bestellung(en) · Gesamt ${money(revenue, orders[0]?.currency)}`;
  table.hidden = orders.length === 0;
  empty.hidden = orders.length !== 0;
}

/**
 * Fetches the order list and renders it.
 *
 * The refresh button is disabled for the duration so double-clicks cannot interleave two renders, and a
 * failure replaces the summary line instead of leaving an empty table that looks like "no orders".
 */
async function load() {
  refresh.disabled = true;
  try {
    const response = await fetch("/api/orders");
    if (!response.ok) throw new Error();
    render(await response.json());
  } catch {
    stats.textContent = "Bestellungen konnten nicht geladen werden.";
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", load);
load();
