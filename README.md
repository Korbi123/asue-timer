# ASÜ-Timer 1.0.0

Stoppuhr und Rechenhilfe für die Atemschutzüberwachung nach FwDV 7, als installierbare Web-App (PWA).
Maßgeblich bleibt die Atemschutzüberwachungstafel. Die App erinnert, warnt und rechnet.

## Bereitstellen

Eine PWA lässt sich nur über **HTTPS** installieren. Den kompletten Ordnerinhalt unverändert auf einen
beliebigen statischen Webspace legen, zum Beispiel:

- **GitHub Pages**: Repository anlegen, Dateien hochladen, unter *Settings → Pages* den Branch freigeben.
- **Netlify / Cloudflare Pages**: Ordner per Drag & Drop hochladen.
- **Eigener Webserver** mit TLS-Zertifikat (auch in einem Unterordner, alle Pfade sind relativ).

Es gibt keinen Server-Teil, keine Datenbank und keine Übertragung von Daten.

## Installieren

- **Android (Chrome):** Seite öffnen → in der App *Einstellungen → App installieren* oder Browsermenü → *App installieren*.
- **iOS (Safari):** Seite öffnen → *Teilen* → *Zum Home-Bildschirm*.

Nach dem ersten Laden läuft die App vollständig offline.

## Bedienung in Kürze

1. **Neuer Einsatz** oder **Neue Übung**.
2. **Trupp anlegen**: Kennung, Namen, Gerät, Zeitmodus → **Anfangsdruck** von TF und TM eingeben
   (zum Beispiel im Fahrzeug beim Anlegen des Geräts) → *Anlegen*.
   Mit *Anlegen & starten* läuft der Trupp sofort.
3. **Start (Anschluss)** beim Losgehen. Die Druckeingabe ist hier optional: *Unverändert* übernimmt den Anfangsdruck,
   ein neu eingegebener Wert ersetzt ihn als Startdruck.
4. Bei ⅓ und ⅔ alarmiert die App, bis die Druckabfrage quittiert ist.
5. Jeder Wert ist korrigierbar (✎), jede Aktion 5 Sekunden lang rückgängig zu machen.

## Rechenregeln

- **Startdruck** = Druck beim Anschluss, falls erfasst, sonst Druck beim Anlegen.
- **Zeiten** (⅓, ⅔, Ende, Verbrauch) laufen ab dem Anschluss.
- Erwartete Einsatzzeit: fester Wert, Atemluft ÷ Verbrauch oder Startdruck × l/bar ÷ Verbrauch (abgerundet).
- Rückzugsdruck: mit Ziel `max(2 × (Start − Ziel), Warnsignal)`, sonst Drittel-Regel `Start − (Start − Warnsignal) ÷ 3`.
- Verbrauch: Standardwert bis zur ersten Druckabfrage, danach gemessen seit Anschluss.

## Grenzen einer Web-App

- Zuverlässig alarmiert die App nur **im Vordergrund**. Solange ein Trupp läuft, hält sie den Bildschirm an.
  Im Hintergrund kommen Alarme als Benachrichtigung, das System kann sie aber verzögern.
- Der Alarmton läuft über die **Medienlautstärke**. Den Lautlos-Modus kann eine Web-App nicht übersteuern.
  Vor jedem Dienst *Einstellungen → Alarm testen*.
- Nach dem Öffnen braucht der Browser **einen Fingertipp**, bevor Ton möglich ist. Die Kopfleiste zeigt dann „🔇 Ton aktivieren“.
- Daten liegen nur im Browser-Speicher dieses Geräts. Wer die Website-Daten löscht, löscht auch Einsätze und Verlauf.

## Updates

1. Dateien ändern.
2. Versionsnummer in `sw.js` (`VERSION`) **und** in `js/core.js` (`APP_VERSION`) erhöhen.
3. Hochladen. Die App zeigt „Neue Version verfügbar“ und aktualisiert erst auf Knopfdruck, nie mitten im Einsatz.

## Lokal testen

```
python3 -m http.server 8000
```

Dann `http://localhost:8000` öffnen (localhost gilt als sicherer Kontext, Service Worker funktioniert).

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Einstieg |
| `js/core.js` | Rechenkern (reine Funktionen, Selbsttest) |
| `js/app.js` | Oberfläche, Dialoge, Speicherung, PWA-Anbindung |
| `css/app.css` | Gestaltung (Dunkel/Hell) |
| `sw.js` | Service Worker: Offline-Cache, Updates, Benachrichtigungs-Klick |
| `manifest.webmanifest` | App-Name, Icons, Startverhalten |
| `icons/` | App-Icons (inkl. maskable und Apple-Touch-Icon) |
