const rows = document.getElementById("rows");
const table = document.getElementById("table");
const empty = document.getElementById("empty");
const stats = document.getElementById("stats");
const refresh = document.getElementById("refresh");

const money = (value, currency) =>
  new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: currency || "EUR",
  }).format(value);

function cell(label, content) {
  const td = document.createElement("td");
  td.dataset.label = label;
  if (typeof content === "string") td.textContent = content;
  else td.append(content);
  return td;
}

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
