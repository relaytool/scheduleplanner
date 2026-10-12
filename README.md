# Relay Warehouse & Yard Schedule

A static JavaScript web app for the 07:00–19:00 and 19:00–07:00 warehouse shifts.

## Quick start

1. Complete the Google Cloud / OAuth setup in [SETUP.md](SETUP.md).
2. Replace the placeholder client ID in `config.js`.
3. Run `python3 -m http.server 8000` and visit `http://localhost:8000`, or host the folder on a static HTTPS site.
4. Sign in with the warehouse operator Google account and allow Sheets access.

No Google Apps Script or `.gs` files are used. The app creates `Schedule`, `ShiftLinks`, and `AuditLog` tabs in the destination workbook on first authorised login.

## Files

- `index.html` — application shell
- `app.js` — Google Sheets integration, warehouse UI, modal actions, public marshall view
- `logic.js` — shift and schedule selection logic
- `styles.css` — responsive mobile/desktop design
- `config.js` — the two spreadsheet IDs and OAuth client ID placeholder
- `tests/logic.test.cjs` — basic automated logic checks

Run tests with:

```bash
node tests/logic.test.cjs
```

See `SETUP.md` for the complete configuration steps and the public-sheet access limitation.
