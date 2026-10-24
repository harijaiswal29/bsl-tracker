# BSL Tracker

Log what you eat in a few seconds, and over time see **which foods spike your blood sugar and which don't**.

A home-screen web app (PWA) for your phone. It works offline, needs no account or server, and keeps all data on your device.

## What it does

| Tab | What you do there |
|---|---|
| **Log** | Type what you ate (`2 rotis, dal, salad`) → **Save meal**. The time fills itself in; tap *15 min ago* / *1 hr ago* / *Pick time…* if you're logging late. Your usual meals show up as one-tap suggestions. Optional tags: *Walked after*, *Veggies first*, *Took meds*, *Stressed*… Switch to **Glucose** to enter a fingerstick reading. Every save has **Undo**. |
| **Days** | One day at a time: glucose curve, your target band, meal markers (tap one for details), and every meal labelled with its rise: `+53 ▲▲ Spike`. |
| **Insights** | Your meals ranked from gentlest to spikiest, single foods across meals (e.g. every meal with *rice*), whether habits like walking after eating help, plus average glucose, time in range and GMI (estimated A1c) when you have CGM data. |
| **More** | Import glucose data, settings (mg/dL ↔ mmol/L, target range, reminders), backup/restore, CSV export for your doctor. |

### How a meal is scored

For each meal: **rise = highest reading in the 2½ hrs after eating − the reading just before eating.**

- `< 30 mg/dL` → ✓ Gentle · `30–49` → ▲ Moderate · `≥ 50` → ▲▲ Spike
- Meals eaten within 30 min of each other (chai, then breakfast) are scored as one.
- A meal followed by more food within 2 hrs is still shown, but it's left out of rankings because the second meal muddies the result.

### Your two meters

- **FreeStyle Libre 2 (CGM):** just log meals. Every week or so, on **libreview.com → Glucose History → Download glucose data**, save the CSV and import it under **More → Import**. Every meal gets scored automatically. Re-importing overlapping files is safe; duplicates are skipped. Turn *After-meal check reminders* off.
- **Accu-Chek (fingerstick):** take a reading **before eating** and **~2 hrs after** (or 1 hr and 2 hrs). The Log screen shows *⏰ 2 hr check after lunch · due 3:05 pm* when a check is due. If you use mySugr, its CSV export can be imported too.

## Install on your phone

1. Deploy (below) and open the site URL on your phone.
2. **Android / Chrome:** ⋮ menu → *Add to Home screen* / *Install app*.
   **iPhone / Safari:** Share → *Add to Home Screen*.
3. Open it from the home-screen icon. From then on it works offline.

> **Back up every couple of weeks** (More → Back up → save to Drive / email / WhatsApp-to-self).
> Data lives only on the phone, so if you clear browser data or lose the phone, the backup is your copy.

## Deploy (GitHub Pages, free)

1. Merge into `main`.
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` runs the tests and publishes to
   `https://harijaiswal29.github.io/bsl-tracker/`. Each deploy gets a new offline-cache name, so installed apps
   show *"A new version is ready → Refresh"*.

Only the app code is public. Your meals and readings never leave your phone.

## Develop

No build step and no dependencies: plain HTML, CSS and ES modules.

```bash
npm start      # serves on http://localhost:8000
npm test       # unit tests for scoring + CSV import (Node 20+)
```

```
index.html, css/app.css      UI shell and styles (light + dark)
js/app.js                    screens, forms, sheets, import/backup
js/analysis.js               meal scoring, rankings, habits, time-in-range  (pure, tested)
js/importers.js              LibreView + generic meter CSV parsing         (pure, tested)
js/chart.js                  SVG glucose chart with tap/hover readout
js/db.js                     IndexedDB storage
sw.js, manifest.webmanifest  offline + installable
```

## Ideas for later

- Meal photos, and voice input (the phone keyboard's mic already works in the text box)
- LLM-estimated carbs from the meal text
- Sync between devices (e.g. via Google Drive)
- Live Libre data via LibreLinkUp instead of CSV import

---

*A personal tracking tool, not a medical device. Discuss changes to diet or medication with your doctor.*
