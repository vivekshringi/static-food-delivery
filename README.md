# Restaurant Monorepo (Express + React)

Dieses Projekt enthalt:

- `packages/server`: Express API mit token-geschutztem Admin-Bereich
- `packages/web`: React Frontend mit Home, Menu und Admin Interface

## Features

- Home-Seite mit Infos zu Restaurant, Chef, indischer Kuche, Adresse, Offnungszeiten
- Home-Seite mit Chef-Profilbild und "Signature Dishes"-Karussell aus den optimierten Gerichtsfotos
- Header/Home mit Logo-Unterstutzung (`logoUrl`) und direktem Menu-PDF Schnellzugriff
- Teaser-Bereich fur kommende Angebote
- Footer mit Instagram-, Facebook- und X-Handles
- Google-Bewertungen als Highlight-Slider auf der Home-Seite (Live uber Places API oder als Fallback aus Content)
- Menu-Seite zeigt PDF direkt im Browser (`/menu.pdf`)
- Responsives Design fur Desktop, Tablet und Mobile
- Admin Interface (`/admin`) zum Aktualisieren der Inhalte und Ersetzen der PDF-Speisekarte
- Admin Flow: zuerst Token-Login auf `/admin`, danach Weiterleitung auf `/admin/edit`
- GDPR-konformer Cookie Banner mit Kategorien (essenziell, Analyse, Marketing) inkl. nachtraglichem Bearbeiten
- Admin APIs sind per Bearer Auth Token geschutzt

## Start

1. Abhangigkeiten installieren:

```bash
npm install
```

2. Entwicklungsmodus starten (Server + Frontend):

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Server: `http://localhost:4000`

## Design-System

Das Frontend nutzt ein gemeinsames Token-Set in `packages/web/src/styles.css`. Alle Farben,
Radien, Schatten, Schriftfamilien und Easings liegen als CSS-Variablen in `:root`, sodass sich das
Erscheinungsbild zentral aendern laesst.

| Baustein | Datei | Inhalt |
| --- | --- | --- |
| Basis | `src/styles.css` | Tokens, Hintergrund (Aurora + Grain), Header, Hero, Panels, Buttons, Formulare, Footer, States |
| Sektionen | `src/showcase.css` | Gerichts-Karussell, Angebote, Menue-Seite, Admin, Impressum, Partner-Logos, Cookie-Dialog, Responsive-Stufen |
| Bestelloberflaeche | `src/ordering.css` | Chat, Menue-Karte im Chat, Bestell-Tabelle, Zahlungsdetails |
| Review-Slider | `src/reviews/reviewsSlider.css` | Mapping der Widget-Variablen auf die Seiten-Palette |

Helle, warme Papier-Palette (kein Dark Mode): Grundflaeche `#faf6ee`, Karten `#fffdf9`. Fuer Text auf
hellem Grund gibt es zu jeder Spice-Farbe eine dunklere Variante (`--chilli-deep`, `--saffron-deep`,
`--cardamom-deep`), weil der helle Ton nur als Fuellung taugt. Alle Textfarben erreichen mindestens
4.5:1 Kontrast (WCAG AA), geprueft automatisch ueber alle vier Seiten.

Schriften: **Instrument Serif** fuer Ueberschriften, **Bricolage Grotesque** fuer Fliesstext,
**JetBrains Mono** fuer Bestell-Codes und Preise. Alle drei kommen von Google Fonts, das in der CSP
(`GOOGLE_FONT_ORIGINS` in `packages/server/src/index.js`) bereits erlaubt ist.

Bewegung: sanft driftende Farbwaesche im Hintergrund, Hover-Lift auf Panels, Sheen auf dem
Haupt-Button, gestaffelte Chat-Bubbles, pulsierender Live-Punkt. `prefers-reduced-motion` schaltet alle Animationen ab; kein
Inhalt haengt von einer Animation ab, um sichtbar zu werden.

## Signature Dishes (Gerichtsfotos)

Die Fotos im Karussell auf der Home-Seite werden nicht uber das Admin-Formular gepflegt, sondern
beim Build aus den Originaldateien erzeugt:

1. Neue Fotos als `NN_name.png` in `packages/web/assets/dishes-source/` ablegen (`NN` = Reihenfolge).
   Der Ordner liegt bewusst ausserhalb von `public/`, damit Vite die ~34 MB PNGs nicht mitbaut.
2. `npm run dishes -w @restaurant/web` ausfuehren.

Das Skript schreibt nach `packages/web/public/dishes/` je Foto ein 400px- und ein 800px-WebP, die
gleichen Breiten als JPEG-Fallback sowie ein 32px-Platzhalterbild, und aktualisiert
`packages/web/src/dishes.js`. Aus 34 MB PNG werden so rund 3 MB. `npm run build` fuehrt das Skript
automatisch mit aus, ein vergessenes Neu-Erzeugen kann also nicht passieren.

Die Fotos sind quadratisch und tragen den Gerichtenamen bereits im Bild, deshalb zeigt das
Karussell sie unbeschnitten und ohne separate Bildunterschrift.

## Admin Token

Der Admin-Token **muss** gesetzt sein. Ohne `ADMIN_TOKEN` bzw. `ADMIN_TOKEN_HASH`
antworten alle Admin-Endpunkte mit `503` (fail closed) — es gibt keinen Standard-Token.

Der Token wird serverseitig als SHA-256 Hash verglichen (nicht im Klartext gespeichert).

Fur lokale Entwicklung: Token in `.env` setzen.

```bash
ADMIN_TOKEN=dein-geheimer-token
```

Produktiv sollte ein eigener Token gesetzt werden:

```bash
ADMIN_TOKEN=mein-sicherer-token npm run start
```

Alternativ kann direkt ein Hash gesetzt werden:

```bash
ADMIN_TOKEN_HASH=<sha256-hash> npm run start
```

Im Frontend unter `/admin` den Token eingeben, dann Inhalte speichern oder eine neue PDF hochladen.

## Chat-Agent Modell (OpenAI oder Ollama)

Das Modell des Chat-Agents (`packages/agent/agent.js`) wird uber `AGENT_MODEL` gesteuert.
Standard ist `openai:gpt-4o`. Jeder von LangChain `initChatModel` unterstutzte Provider funktioniert.

OpenAI:

```bash
OPENAI_API_KEY=<dein-key> npm run start
```

Lokales Ollama (Modell mit Tool-Calling-Unterstutzung, z. B. `llama3.1`, `qwen2.5`):

```bash
curl http://127.0.0.1:11434/api/tags   # verfugbare Modelle prufen
OLLAMA_BASE_URL=http://127.0.0.1:11434 AGENT_MODEL=ollama:llama3.1 npm run start
```

Ollama Cloud (benotigt `OLLAMA_API_KEY`):

```bash
OLLAMA_BASE_URL=https://ollama.com OLLAMA_API_KEY=<dein-key> AGENT_MODEL=ollama:deepseek-v4.1-flash:cloud npm run start
```

`OLLAMA_BASE_URL` zeigt lokal standardmassig auf `http://127.0.0.1:11434`; fuer Ollama Cloud muss es auf `https://ollama.com` zeigen. Fly.io setzt die Cloud-URL ueber `fly.toml`.

## Bestellen mit Menue-Codes

Der Agent zeigt nach der Begruessung sofort die komplette Speisekarte. Jede Kategorie hat eine
Nummer (1, 2, 3 ...) und jedes Gericht darin einen Buchstaben (a, b, c ...). Zusammen ergibt das den
Bestell-Code, zum Beispiel `1b` = Kategorie 1, zweites Gericht. Danach wird die Kundennummer
abgefragt; nach der Pruefung bestellt der Kunde direkt per Code ("1b", "2c und 16c").

- Die Nummerierung kommt aus der Position im Menue und ignoriert die Tageszeit. `1b` bezeichnet
  mittags und abends dasselbe Gericht, auch wenn einzelne Kategorien nur zu einer Tageszeit
  angeboten werden (fehlende Nummern sind normal).
- `resolveMenuCode()` in `packages/agent/agent.js` loest einen Code serverseitig auf; Preise,
  Allergene und Bestellpositionen stammen immer aus den Menuedaten, nie aus dem Modell.
- `get_full_menu` liefert das komplette Menue mit Codes, `get_categories`,
  `get_flavours_by_category` und `find_flavour` geben die Codes ebenfalls mit aus.

## Kundennummer im Browser merken

Nach einer erfolgreichen Pruefung merkt sich der Tab die Kundennummer in `sessionStorage`
(`ankerVerifiedCustomerV1`). Ein Reload innerhalb der Bestellung sendet sie beim Chat-Start mit, und
der Agent begruesst den Kunden direkt mit der Speisekarte, ohne erneut nach der Nummer zu fragen.

- Das gilt nur fuer die laufende Bestellung: mit dem Schliessen des Tabs ist die Nummer weg.
- Sobald die Bestellung abgeschlossen ist (PayPal-Zahlung eingegangen und `finalize_order` gelaufen),
  antwortet der Server mit `orderPlaced: true`. Die Seite loescht dann die Nummer, blendet das
  Eingabefeld aus und bietet **Neue Bestellung** an; ein Reload startet ebenfalls eine neue
  Bestellung und fragt wieder nach der Nummer.
- Die Nummer wird serverseitig erneut geprueft (`verifyCustomerNumber`) und zaehlt bei einem
  Fehlversuch in dasselbe Limit wie `verify_customer_number`. Ein manipulierter Speicherwert
  verschafft also keinen Vorteil und verbraucht Fehlversuche.
- Ist die gemerkte Nummer nicht mehr gueltig, antwortet der Server mit `customerNumberRejected: true`.
  Die Seite loescht sie dann, damit beim naechsten Reload wieder gefragt wird, statt jedes Mal
  einen Fehlversuch zu verbrauchen.
- Die Chat-Zugangsdaten (`user`/`password` aus der URL) werden fuer den Tab ebenfalls in
  `sessionStorage` gehalten (`ankerChatCredentialsV1`), damit ein Reload den Chat fortsetzen kann.
  Ein neuer Tab braucht weiterhin den Link.

## Speisekarte im Chat

Die Speisekarte steht direkt im Chat: die Begruessung liefert sie als `menu` mit, und die Seite
rendert sie unter der Begruessung (`GET /api/order-menu` liefert dieselben Daten fuer andere
Aufrufer). Kategorien tragen ihre Menue-Nummer, Gerichte ihren Buchstaben, zusammen den Bestell-Code
(`1b`). Das Modell wiederholt das komplette Menue nicht mehr, sondern nennt nur den Code-Hinweis und
fragt die Kundennummer ab.

- Der Chat scrollt mit der Seite; nur das Eingabefeld bleibt unten sichtbar (`position: sticky`).
  So ist das lange Menue auf dem Handy ein einziger, natuerlicher Scroll ohne verschachtelte Box.
- Auf Bildschirmen bis 680 px scrollt die Kopfzeile mit, statt zwei Navigationszeilen dauerhaft
  ueber dem Inhalt zu halten.

## Aktuelle Bestellungen und Push-Benachrichtigung

`/currentOrders` liest den Admin-Token selbst aus `sessionStorage`. Nach dem Login auf `/admin`
fuehrt der Link **Aktuelle Bestellungen** deshalb direkt auf die Bestellliste statt zurueck zum
Login (der Token existiert erst nach dem Login, ein beim App-Render uebergebenes Prop waere leer).

Neue Bestellungen erscheinen ohne Neuladen: der Server bietet einen Server-Sent-Events-Stream an
(`GET /api/admin/orders/stream`), der beim Abschluss einer Bestellung (`finalizeOrder`) ein
`order.placed`-Event pusht.

- Die Seite abonniert den Stream per `EventSource` und zeigt ein Banner ("1 neue Bestellung
  eingegangen") mit Kunde und Betrag sowie einen Live-Indikator. Danach laedt sie die Liste neu,
  damit alle Spalten aus derselben Quelle kommen.
- `EventSource` kann keinen `Authorization`-Header senden, daher nimmt der Stream den Token als
  Query-Parameter und prueft ihn vor dem Oeffnen. Ohne gueltigen Token: `401`.
- Nach einem Verbindungsabbruch verbindet sich der Browser selbst neu und der Server schickt die
  verpassten Events aus einem Ringpuffer (50 Events) nach; Keep-Alive-Kommentare halten Proxys
  davon ab, die Verbindung zu schliessen.
- Der Push laeuft im selben Prozess wie der Agent. Bei mehreren Instanzen (z. B. mehreren
  Fly-Machines) erreicht ein Event nur die Clients der Instanz, die die Bestellung abgeschlossen
  hat; dafuer waere ein gemeinsamer Broker noetig.

## Chat-Schutz vor Missbrauch

Der Chat ist durch Limits geschuetzt, die im Code und nicht nur im Prompt stehen:

- `verify_customer_number` zaehlt Fehlversuche. Nach 3 Fehlversuchen ist der Thread gesperrt und
  der Server antwortet mit `429`.
- Zusaetzlich gilt ein Limit pro Client (IP), damit ein Angreifer die Thread-Sperre nicht durch
  eine neue `threadId` umgeht. Standard: 15 Fehlversuche in 15 Minuten.
- `/api/chat` ist pro Client begrenzt: 30 Nachrichten pro Minute, 5 neue Chats pro Minute.
- Der Agent hat keine Delegation an einen Sub-Agenten; das `task`-Tool ist deaktiviert.

```bash
TRUST_PROXY=true                      # hinter Reverse Proxy / Fly.io
CHAT_RATE_LIMIT=30                    # Nachrichten pro Minute und Client
CHAT_NEW_THREAD_RATE_LIMIT=5          # neue Chats pro Minute und Client
CHAT_MAX_VERIFICATION_FAILURES=15     # Fehlversuche pro Client in 15 Minuten
CHAT_TURN_TIMEOUT_MS=90000            # maximale Dauer einer Chat-Antwort
CORS_ORIGINS=https://app.example.de   # nur fuer ein separates Frontend noetig
```

`TRUST_PROXY=true` ist fuer Fly.io bereits in `fly.toml` gesetzt. Ohne diese Option teilen sich
hinter einem Proxy alle Besucher eine Adresse, und die Limits wuerden global statt pro Client gelten.

Zusaetzlich gilt: ein `threadId` gehoert dem Client, der ihn zuerst benutzt hat (sonst `403`),
und `orders.json` wird beim Bestellabschluss und beim stuendlichen Backup serialisiert
geschrieben, damit keine bezahlte Bestellung verloren geht.

## API Endpoints

Die Routen sind in `packages/server/src/index.js` in drei Gruppen sortiert: oeffentlich, Bestellung, Admin.

Oeffentlich:

- `GET /api/health` - Liveness-Probe
- `GET /api/content` - Offentliche Inhalte fur Frontend
- `GET /api/menu` - Mittags- und Abendkarte (ohne Bestell-Codes)
- `GET /api/order-menu` - Komplette Speisekarte mit Menue-Codes fuer die aktuelle Tageszeit
- `GET /menu.pdf` - Speisekarte inline im Browser anzeigen

Bestellung (HTTP Basic mit `CHAT_USER` / `CHAT_PASSWORD`):

- `POST /api/chat` - Eine Chat-Runde; liefert Antwort, Menue-Karte, gemerkte Kundennummer und Zahlungsstatus
- `GET /api/paypal/config` - PayPal Client-ID fur das SDK
- `POST /api/paypal/create-order` - PayPal-Order fur die offene Zahlung anlegen
- `POST /api/paypal/capture-order` - Zahlung nach Freigabe einziehen (Betrag und Waehrung werden geprueft)

Admin (Bearer Token erforderlich):

- `POST /api/admin/auth` - Token prufen fur Admin Login
- `PUT /api/admin/content` - Inhalte aktualisieren
- `POST /api/admin/menu` - Menu PDF hochladen
- `GET /api/admin/customers` / `PUT /api/admin/customers` - Kundenliste lesen und ersetzen
- `GET /api/admin/orders/stream` - Live-Benachrichtigung neuer Bestellungen (SSE, Token als Query-Parameter)
- `GET /api/admin/orders-backup` - Stuendliches Bestell-Backup herunterladen
- `GET /api/orders` - Bestellungen inklusive Zahlungsdaten
- `GET /api/payments` - Zahlungsdatensaetze
