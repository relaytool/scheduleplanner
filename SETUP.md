# Relay Warehouse + Yard Marshall Schedule

Browser-only JavaScript web app. It does **not** use Google Apps Script, `.gs` files, or a server-side backend. The warehouse operator signs in using Google Identity Services and the Google Sheets API. Yard marshalls use a temporary QR/link without signing in.

## What the app does

- Reads the RHS FM tracker workbook as the source of truth.
- Uses the source tab matching gid `1760538646`; if that gid is unavailable, it falls back to the tab called `FM collection tracker`.
- Chooses **Case 2** when at least one qualifying row exists in the current shift: HSC is `NG15` or `WS2`, load type contains `INTERCITY`, and postcode contains `UB11`. When Case 2 exists, it displays only the Case 2 set for that shift. Otherwise it displays Case 1 rows where HSC is `UB11`.
- Case 1 event time is **Planned Pull**. A source Actual Pull time automatically marks the row complete. On completion, “Time at HSC” is calculated from **Actual arrival time HSC minus Planned Pull**. The similarly named **Actual Arrival** field is kept separate and means actual arrival at the collection location.
- Case 2 event time uses **Actual Arrival** when it contains a valid clock time; otherwise it falls back to **Planned arrival**.
- A bay assignment changes status to `Docked`. Manual completion records the current timestamp. Changes are written to `Schedule` and recorded in `AuditLog`.
- A temporary marshall link is valid only for the shift in which it was generated and expires at 07:00 or 19:00. The yard view polls the public spreadsheet every minute and displays outstanding items with event times between now and two hours from now.

## One-time Google setup

### 1. Confirm spreadsheet access

The configured spreadsheets are:

- **Source (read-only):** `1WqGcIzuL2l3BL_okzDf-nNqKrAmYKG5v_ZpeVBsH3xk`
- **Destination (operational data):** `1ME1GP76QH14NvRIbLbHYh3Zj9DuNHejcIOY0IOY2nzg`

The Google account used by the warehouse operator must be able to view the source workbook and **edit** the destination workbook. The app creates these destination tabs if they do not exist:

- `Schedule`
- `ShiftLinks`
- `AuditLog`

The app does not change sharing permissions. To support unauthenticated yard links, open the destination workbook in Google Sheets, select **Share**, and set **General access** to **Anyone with the link · Viewer**. Keep edit access restricted to warehouse operators.

### 2. Enable the Google Sheets API

1. Open the Google Cloud Console: https://console.cloud.google.com/
2. Create or select a project.
3. Open **APIs & Services → Library**.
4. Enable **Google Sheets API**.
5. Configure the OAuth consent screen. For an app used privately by a small team, use the appropriate audience for your Google Workspace/personal account and add operator accounts as test users if the app remains in testing mode.

### 3. Create the OAuth client ID

1. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Choose **Web application**.
3. Add this authorised JavaScript origin for local testing:

   `http://localhost:8000`

4. Add your deployed website's **origin** too. For GitHub Pages it looks like `https://YOUR-USERNAME.github.io` (do not include a repository path in the origin).
5. Copy the client ID. It normally ends with `.apps.googleusercontent.com`.
6. Open `config.js` and replace:

   `YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com`

   with your real client ID.

The client ID is intended to be used in browser code. Do not put a client secret into this project.

### 4. Run locally

From this folder, run:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Do not open `index.html` directly as a `file://` URL; Google OAuth needs a web origin.

Click **Continue with Google**, sign in with the operator account, and approve Sheets access. The app will create its tabs in the destination workbook, read the current shift from the source, sync the selected schedule, and show the timeline.

### 5. Publish the app

Any static HTTPS host works, including GitHub Pages. Upload the contents of this folder and enable Pages for the branch/folder containing `index.html`. Add the exact site origin in your Google OAuth client settings. The temporary link/QR uses the current app URL, so use the deployed URL when generating links for the yard team.

## Daily use

1. Open the deployed site and choose **Warehouse schedule**.
2. Sign in with Google. The app syncs the shift active at login.
3. Use **Refresh tracker** to pull updated source data again.
4. Open a card to inspect details, choose a bay, or mark it complete. Assigning a bay changes status to `Docked`.
5. Choose **Create marshall link + QR**, then share the link or show the QR code. Creating a new link for the same shift invalidates the prior link for that shift.
6. The marshall opens the link on a phone without signing in. The page refreshes every minute and filters to the next two hours. The app link stops working at shift end.

## Important access limitation

This version has no server-side component, by request. Therefore the two-hour limitation is a **view-level filter in the marshall page**, not a security boundary on data stored in Google Sheets. Because the destination workbook is shared as “Anyone with the link · Viewer” to support no-sign-in access, a person who opens the workbook directly can inspect its tabs and schedule data outside the app's two-hour filter. `ShiftLinks` stores only a SHA-256 hash of the random link token, not the token itself, but the schedule and audit rows are still in the public workbook. Do not store sensitive or confidential data there. Enforcing the two-hour limit at the data layer would require a separate public-only feed or a backend service with access controls; this app intentionally does not add one.

## Troubleshooting

- **`Setup is not finished`:** replace the placeholder OAuth client ID in `config.js`.
- **`origin_mismatch`:** add the exact current site origin to the OAuth client (scheme and host, no path).
- **Console shows `content-sheets.googleapis.com/v4/spreadsheets/...` with HTTP 403:** the app is failing while opening spreadsheet metadata, before it creates tabs or saves schedule rows. First enable **Google Sheets API** in the exact Google Cloud project that owns the OAuth Client ID in `config.js`. Then open the destination workbook, share it with the exact Google account used to sign in, and give that account **Editor** access. “Anyone with the link · Viewer” allows the marshall to read the public view but does not grant the operator write permission. Sign out and sign in again after changing permissions. The app now surfaces the Google response details in its connection error panel; the exact reason may identify a disabled API, insufficient scope, quota, or spreadsheet access problem.
- **`Cross-Origin-Opener-Policy policy would block the window.opener call`:** this is a Google sign-in popup/browser isolation warning, separate from the Sheets API 403. If the Google account picker closes and the app continues to a Sheets request, focus on the 403 first. If sign-in itself hangs or the popup remains blank, check the hosting platform's COOP header guidance and browser popup/privacy settings. On a host that supports response headers, Google documents `Cross-Origin-Opener-Policy: same-origin-allow-popups` as a relevant configuration for popup communication when FedCM is disabled.
- **Google sign-in works but destination update fails:** confirm the signed-in account can edit the destination workbook and that Google Sheets API is enabled in the OAuth client's Cloud project.
- **Source tab/gid warning:** copy the gid from the RHS tracker tab URL into `sourceSheetGid`; confirm `sourceFallbackTabName` is correct.
- **No schedule rows:** check that the tracker date headers exist, the source data contains valid times, and the relevant scheduled event belongs to the current 07:00–19:00 or 19:00–07:00 window. Case 2 replaces Case 1 only when qualifying Case 2 rows occur in the current shift.
- **Marshall page cannot load:** make sure the destination workbook is accessible as Viewer to anyone with the link, the app is hosted on HTTPS, and the link has not reached 07:00/19:00.
- **QR library blocked:** the plain temporary link still works; use **Copy link**.
