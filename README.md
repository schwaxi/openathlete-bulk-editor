# OpenAthlete Bulk Editor

An **unofficial** companion app for self-hosted [OpenAthlete](https://github.com/openathleteorg/openathlete):
bulk-edit your activities and import your full Garmin history.

> Not affiliated with or endorsed by the OpenAthlete project.
> The user interface is in German (contributions for other languages welcome).
> 🇩🇪 Deutsche Anleitung: [ANLEITUNG.md](ANLEITUNG.md)

## Features

**Bulk editing**
- Filter activities by name (substring, whole word, `*`/`?` wildcards or regex), sport, equipment and date range
- Change the **sport type**, assign or remove **equipment** (bike/shoe) and **rename** many activities at once
  - search & replace in names
  - name templates with placeholders: `{name} {nr} {datum} {tag} {monat} {jahr} {km} {rad} {sport}`
    (running number with start value, zero padding and order)
- **Live preview** of every change (old → new) before anything is written
- **Undo** the last run
- **Rules** by name tag, e.g. every activity containing `M9` → sport *Velomobile* + bike *Velomobil M9*.
  Rules are saved and can be re-applied after each sync with one click.
- Change log in `data/aenderungen.log`

**Garmin history import**
- OpenAthlete's Garmin Personal API import accepts at most 28 days per request and 3 requests per 15 minutes.
  The editor splits any date range into 28-day chunks and works through them while respecting those limits.
- Runs **server-side**: you can close the browser
- Pause, resume, retry failed chunks. Survives container restarts (log in again and resume).
- Chunks with more than 1000 activities are automatically split in half
- Optionally applies your rules to the imported range when done

**Fetch new activities**
- One-click button in the header: imports everything since the last import and then applies your rules
- Optional: fetch automatically whenever the editor is opened (at most every 30 minutes)
- Lets you turn off OpenAthlete's hourly automatic Garmin sync and import on demand instead

## How it works

The editor logs in with your OpenAthlete account and uses **OpenAthlete's own API**,
the same endpoints the web app uses (`PATCH /event/:id`, `POST /provider/garmin-personal/sync`).
It never writes to the database directly, so OpenAthlete recalculates records and training
load after a sport change, exactly as if you had edited the activity in the app.

Your password is only used to obtain a token and is never stored. Tokens are kept in memory only.

## Installation

The editor runs as an additional container in your OpenAthlete Docker Compose stack
and talks to the API container over the internal network.

Add this service to your OpenAthlete `docker-compose.yml`:

```yaml
  editor:
    image: ghcr.io/schwaxi/openathlete-bulk-editor:latest
    environment:
      OA_API_URL: http://api:3000
    volumes:
      - ./editor-data:/data
    ports:
      - "8096:8080"
    depends_on:
      api:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - openathlete-network
```

Then run `docker compose up -d` and open `http://<your-server>:8096`.

A complete example for Unraid (Docker Compose Manager) is in
[examples/docker-compose.unraid.yml](examples/docker-compose.unraid.yml).

### Without the prebuilt image

The app has **no dependencies** besides Node.js 18+. You can mount the `app` folder into the
official Node image instead:

```yaml
  editor:
    image: node:22-alpine
    working_dir: /app
    command: ["node", "server.js"]
    environment:
      OA_API_URL: http://api:3000
      DATA_DIR: /data
    volumes:
      - ./openathlete-bulk-editor/app:/app:ro
      - ./editor-data:/data
    ports:
      - "8096:8080"
```

Or run it directly: `cd app && OA_API_URL=http://localhost:3000 node server.js`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OA_API_URL` | `http://api:3000` | OpenAthlete API, reachable from the editor container |
| `PORT` | `8080` | Port inside the container |
| `DATA_DIR` | `/data` (image) | Where rules, the change log and the import state are stored |
| `GARMIN_THROTTLE_MS` | `900000` | Window of OpenAthlete's import rate limit (3 per window) |
| `GARMIN_POLL_MS` | `10000` | How often the import status is polled |

## Requirements

- A self-hosted OpenAthlete instance (tested against the 1.x API)
- For the Garmin import: `GARMIN_PERSONAL_API_ENABLED=true` on the OpenAthlete API and a
  Garmin Personal API key entered under *Settings → Connectors*

## Security notes

- Only expose the editor on your local network. It has no own user management and relies on
  your OpenAthlete login.
- Write requests from other origins are rejected. The session cookie is `HttpOnly` and `SameSite=Strict`.

## Compatibility

The editor depends on OpenAthlete's HTTP API. A major OpenAthlete update may change it.
If something breaks after an update, please open an issue.

## License

[MIT](LICENSE)
