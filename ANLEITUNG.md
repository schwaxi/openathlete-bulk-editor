# OpenAthlete Masseneditor – Installation auf Unraid

Der Editor läuft als zusätzlicher Container im bestehenden OpenAthlete-Stack.
Er meldet sich mit deinem OpenAthlete-Konto an und ändert Aktivitäten über die
offizielle Schnittstelle der App (wie beim Bearbeiten in der App selbst).
Nach einer Sportart-Änderung berechnet OpenAthlete Rekorde und Belastung daher
selbst neu. In die Datenbank schreibt der Editor nicht direkt.

## Was er kann

- **Filtern** nach Name (Kürzel, auf Wunsch als ganzes Wort oder Regex), Sportart, Ausrüstung, Zeitraum
- **Massenänderung** der ausgewählten Aktivitäten:
  - Sportart setzen
  - Ausrüstung (Rad/Schuh) zuordnen oder entfernen
  - Name: Suchen & Ersetzen oder neuer Name nach Vorlage mit Platzhaltern
    `{name} {nr} {datum} {tag} {monat} {jahr} {km} {rad} {sport}`
    (fortlaufende Nummer mit Startwert, Stellenzahl und Reihenfolge)
- **Regeln** nach Kürzel, z. B. `M9` → Velomobil + „Velomobil M9“. Sie werden
  gespeichert und lassen sich nach jedem Garmin-Sync mit einem Klick erneut anwenden.
- **Vorschau** jeder Änderung in der Tabelle (alt → neu), bevor etwas passiert
- **Rückgängig** für die letzte Änderung
- **Protokoll** aller Änderungen in `data/aenderungen.log`
- **Garmin-Verlauf importieren** (Reiter „Garmin-Import“): beliebig langer Zeitraum,
  automatisch in 28-Tage-Abschnitte geteilt, läuft im Container weiter (siehe unten)
- **Neue Aktivitäten holen** mit einem Klick (oben rechts): holt alles seit dem letzten
  Import und wendet danach automatisch deine Regeln an
- **Garmin-Export importieren**: die große ZIP aus „Daten exportieren“ von Garmin Connect,
  inklusive **Multisport** (Triathlon wird in Schwimmen, Wechsel, Rad, Laufen geteilt)

## 1. Dateien auf den Server kopieren

Auf dem Unraid-Server soll diese Struktur entstehen:

```
/mnt/user/appdata/openathlete-editor/
├── app/
│   ├── server.js
│   ├── garmin-import.js
│   ├── export-import.js
│   ├── fit.js
│   ├── zip.js
│   └── public/
│       ├── index.html
│       └── rules.js
└── data/            (leer, wird vom Editor befüllt)
```

**Variante A – über die Netzwerkfreigabe (am einfachsten):**
Ist die Freigabe `appdata` per SMB erreichbar (`\\TOWER\appdata`, „TOWER“ = Name
deines Servers), kopierst du den Ordner `app` nach
`\\TOWER\appdata\openathlete-editor\app` und legst daneben einen leeren Ordner `data` an.

Ist `appdata` nicht freigegeben: Unraid → *Shares* → `appdata` → *SMB Security
Settings* → Export auf „Yes“ (oder „Yes (hidden)“) stellen.
Oder du kopierst die Dateien in eine andere Freigabe und passt die zwei Pfade
beim Service `editor` in der Compose-Datei an.

## 2. Compose-Datei ersetzen

Im Docker Compose Manager beim Stack `openathlete` → *Edit Stack* → *Compose File*
den kompletten Inhalt durch [`examples/docker-compose.unraid.yml`](examples/docker-compose.unraid.yml) ersetzen.
Gegenüber deiner bisherigen Datei ist nur der Block `editor:` dazugekommen.
Prüf vorher, ob die Pfade bei `postgres` und `redis` zu deinen bisherigen passen.

### Alternative: fertiges Image von GitHub (ohne Dateien kopieren)

GitHub baut automatisch ein fertiges Image. Damit entfällt Schritt 1, und der
Block `editor:` sieht so aus:

```yaml
  editor:
    image: ghcr.io/schwaxi/openathlete-bulk-editor:latest
    environment:
      OA_API_URL: http://api:3000
    volumes:
      - /mnt/user/appdata/openathlete-editor/data:/data
    ports:
      - "${EDITOR_PORT:-8096}:8080"
    depends_on:
      api:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - openathlete-network
```

Updates holt dann „Update Stack“ automatisch mit, wie bei OpenAthlete selbst.

Optional in der Env-Datei einen anderen Port setzen (Standard 8096):

```env
EDITOR_PORT=8096
```

Prüfen, ob der Port frei ist: `ss -tln | grep :8096` (keine Ausgabe = frei).

## 3. Starten

*Compose Up* klicken. Danach `http://<unraid-ip>:8096` öffnen und mit deinen
OpenAthlete-Zugangsdaten anmelden.

## Benutzung (Kurzfassung)

1. **Aktivitäten laden** (Zeitraum leer = alle).
2. Links filtern, z. B. Name enthält `M9`.
3. **Alle gefilterten auswählen** oder einzelne anhaken.
4. Rechts Sportart, Ausrüstung und/oder Name einstellen. Die Tabelle zeigt sofort,
   was sich ändern würde (gelb markiert).
5. **Änderungen anwenden** → bestätigen → Fortschritt abwarten.
6. Falls etwas nicht passt: **Letzte Änderung rückgängig machen**.

**Regeln** (Reiter rechts oben): Kürzel eintragen, Sportart und Ausrüstung wählen,
*Regeln speichern*. Nach jedem neuen Import einfach *Regeln anwenden* klicken.
Beim Holen über den Editor (siehe unten) passiert das automatisch.

## Neue Aktivitäten holen

Der Button **⟳ Neue Aktivitäten holen** oben rechts holt alle Garmin-Aktivitäten
seit dem letzten Import bis heute (beim allerersten Mal die letzten 7 Tage).
Danach wendet der Editor deine **Regeln** auf diesen Zeitraum an, also Sportart und
Ausrüstung nach Kürzel. Oben rechts steht anschließend z. B. „✓ 3 neu · 2 per Regel angepasst“.

- Unter *Garmin-Import* kannst du **„Beim Öffnen des Editors automatisch holen“**
  einschalten. Dann startet das Holen bei jedem Öffnen bzw. Anmelden von selbst
  (höchstens alle 30 Minuten). Die Einstellung gilt pro Browser.
- Damit nur noch der Editor importiert, in OpenAthlete unter *Settings → Connectors →
  Garmin* das Häkchen **„Jede Stunde automatisch die letzten sieben Tage prüfen“**
  ausschalten. **„Import meiner Garmin-Aktivitäten erlauben“** muss an bleiben.
- Die Regeln gelten für alle Aktivitäten im geholten Zeitraum. Hast du dort eine
  Fahrt mit Kürzel von Hand anders eingestellt, setzt die Regel sie wieder zurück.

## Garmin-Export importieren (inkl. Triathlon)

Für deinen kompletten Verlauf ist das der beste Weg. Hier fehlt nichts, auch keine
Multisport-Aktivitäten. Über die Garmin-Schnittstelle lehnt OpenAthlete Triathlons
und Duathlons nämlich ab.

1. In Garmin Connect den Datenexport anfordern (Konto → Datenverwaltung → Daten
   exportieren). Garmin schickt nach einiger Zeit einen Download-Link per E-Mail.
2. Im Editor unter **Garmin-Import → Garmin-Export importieren** bei „ZIP von deinem
   Rechner“ die ZIP **unverändert** auswählen und **Hochladen** klicken. Entpacken ist
   nicht nötig. Lass das Fenster offen, bis der Fortschrittsbalken fertig ist.
   Alternativ die ZIP selbst in den Ordner `data/import` legen. Auf Unraid gehört
   dieser Ordner aber root, über die Netzwerkfreigabe darfst du dort meist nichts ablegen.
3. Die hochgeladene Datei ist dann unter „Datei im Import-Ordner“ ausgewählt.
   **Prüfen** klicken. Der Editor zeigt, wie viele Aktivitäten im Export sind, aus
   welchem Zeitraum, wie viele davon Multisport sind und wie viele einen Namen aus
   Garmin haben.
4. **Import starten.**

- Jede Aktivität wird einzeln über den Datei-Import von OpenAthlete hochgeladen,
  wie beim Hochladen in der App. Das ist deutlich schneller als der Garmin-Import.
- **Namen** kommen aus der Aktivitätsliste im Export, zugeordnet über die Startzeit.
  Deine Kürzel wie „M9“ sind also dabei. Mit „Danach Regeln anwenden“ setzt der
  Editor am Ende Sportart und Ausrüstung nach deinen Regeln.
- **Multisport** wird geteilt: Aus „Ironman Zell“ werden „Ironman Zell – Schwimmen“,
  „– Wechsel 1“, „– Rad“, „– Wechsel 2“ und „– Laufen“. Jede Teil-Aktivität hat ihre
  eigenen Messwerte (GPS, Herzfrequenz, Leistung, Runden), und die Distanz beginnt
  jeweils bei 0. Die Wechselzonen landen in OpenAthlete als „Sonstiges“.
- **Schon vorhandene** Aktivitäten (z. B. vom Garmin-Import) lehnt OpenAthlete über
  die Startzeit ab. Sie zählen als „schon vorhanden“. Du kannst den Export also
  bedenkenlos über deinen Bestand laufen lassen.
- Abbrechen, Fortsetzen (auch nach einem Neustart) und „Fehlgeschlagene wiederholen“
  funktionieren wie beim Garmin-Import. Fehlgeschlagene stehen mit Grund in einer Liste.
- Für das Entpacken braucht der Editor vorübergehend so viel freien Platz im
  `data`-Ordner, wie die größte innere ZIP groß ist. Nach dem Import kannst du die
  Export-ZIP mit **Löschen** neben der Dateiauswahl entfernen.

## Garmin-Verlauf importieren

Voraussetzung: In OpenAthlete ist die Garmin Personal API eingerichtet
(`GARMIN_PERSONAL_API_ENABLED=true`, Schlüssel unter Settings → Connectors
eingetragen, Aktivitäten-Import eingeschaltet). Der Reiter zeigt oben an, ob das passt.

1. Reiter **Garmin-Import** öffnen.
2. Zeitraum wählen, z. B. ab deiner ersten Garmin-Uhr bis heute.
3. **Import starten.**

Der Editor teilt den Zeitraum in Abschnitte von 28 Tagen und lässt OpenAthlete sie
nacheinander importieren. Dabei hält er die Grenzen von OpenAthlete ein: höchstens
3 Importe pro 15 Minuten und nur einer gleichzeitig. Daraus ergeben sich etwa
**20 Minuten pro Jahr** Garmin-Daten.

- Der Import läuft **im Container**. Du kannst das Browserfenster schließen und
  später wieder reinschauen.
- **Abbrechen** und **Fortsetzen** gehen jederzeit, es geht beim nächsten offenen
  Abschnitt weiter.
- Nach einem **Neustart des Containers** hält der Import an. Neu anmelden und
  „Fortsetzen“ klicken.
- Hat ein Abschnitt mehr als 1000 Aktivitäten (das Maximum von OpenAthlete pro
  Import), holt der Editor ihn automatisch in zwei Hälften nach.
- Schon vorhandene Aktivitäten überspringt OpenAthlete selbst. Ein doppelter
  Import schadet also nicht.
- Die Namen kommen aus Garmin Connect. Deine Kürzel wie „M9“ sind also dabei.
  Mit **„Danach Regeln anwenden“** (Standard) setzt der Editor am Ende Sportart und
  Ausrüstung nach deinen Regeln.
- Spätere Änderungen in Garmin Connect (z. B. ein neuer Name) übernimmt OpenAthlete
  bei einem erneuten Import **nicht**. Bereits importierte Aktivitäten bleiben, wie sie sind.

## Gut zu wissen

- **Erst ausprobieren:** Teste die erste Änderung an ein, zwei Aktivitäten und
  schau sie dir in OpenAthlete an, bevor du hunderte änderst.
- **Ausrüstung anlegen:** Räder legst du in OpenAthlete selbst an (Ausrüstung).
  Danach im Editor *Aktivitäten laden* klicken, dann erscheinen sie in der Auswahl.
- **Namen** dürfen höchstens 100 Zeichen lang sein (Vorgabe von OpenAthlete).
- **Rückgängig** gilt für den letzten Lauf und wird im Browser gespeichert.
  Aus einem anderen Browser geht es nicht.
- **Neu anmelden** musst du nach einem Neustart des Containers.
- **Updates:** Mit kopierten Dateien nutzt der Editor das offizielle Node.js-Image.
  Neue Editor-Versionen kopierst du dann selbst. Mit dem fertigen Image von GitHub
  kommen sie beim „Update Stack“ automatisch. Baut OpenAthlete seine Schnittstelle bei einem
  großen Update um, kann der Editor eine Anpassung brauchen. Die App selbst ist
  davon nicht betroffen.
- **Sicherheit:** Der Editor ist nur im Heimnetz über den Port erreichbar und
  braucht deine OpenAthlete-Anmeldung. Gib den Port nicht nach außen frei.
