# Restaurant Monorepo (Express + React)

Dieses Projekt enthalt:

- `packages/server`: Express API mit token-geschutztem Admin-Bereich
- `packages/web`: React Frontend mit Home, Menu und Admin Interface

## Features

- Home-Seite mit Infos zu Restaurant, Chef, indischer Kuche, Adresse, Offnungszeiten
- Home-Seite mit Chef-Profilbild und Galerie fur Dish-Bilder
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

- `GET /api/content` - Offentliche Inhalte fur Frontend
- `GET /api/reviews` - Google Reviews (Live aus Places API wenn konfiguriert, sonst Fallback aus gespeicherten Inhalten)
- `PUT /api/admin/content` - Inhalte aktualisieren (Bearer Token erforderlich)
- `POST /api/admin/menu` - Menu PDF hochladen (Bearer Token erforderlich)
- `POST /api/admin/auth` - Token prufen fur Admin Login
- `GET /menu.pdf` - Speisekarte inline im Browser anzeigen

## Google Reviews einrichten

1. Optional im Admin unter `/admin/edit` den `Google Place ID` hinterlegen.
2. Auf dem Server die Umgebungsvariable `GOOGLE_PLACES_API_KEY` setzen.
3. Wenn kein API Key gesetzt ist, nutzt die Website automatisch die im Admin gepflegten Fallback-Reviews.

Beispiel:

```bash
GOOGLE_PLACES_API_KEY=<dein-key> npm run start
```
