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

Standard-Token im Server:

- `demo-admin-token`

Der Token wird serverseitig als SHA-256 Hash verglichen (nicht im Klartext gespeichert).

Empfohlen fur lokale Entwicklung: Token in `.env` setzen.

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

## API Endpoints

- `GET /api/content` - Offentliche Inhalte fur Frontend
- `PUT /api/admin/content` - Inhalte aktualisieren (Bearer Token erforderlich)
- `POST /api/admin/menu` - Menu PDF hochladen (Bearer Token erforderlich)
- `POST /api/admin/auth` - Token prufen fur Admin Login
- `GET /menu.pdf` - Speisekarte inline im Browser anzeigen
