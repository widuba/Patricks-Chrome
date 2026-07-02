# Browser Activity Tracker

A small self-hosted tool for tracking how much time you spend in the browser,
with optional time-of-day restrictions. It has two halves that share one
Firebase project:

| Part | Folder | What it does |
| --- | --- | --- |
| **Extension** | [`browser-activity-extension/`](browser-activity-extension) | A Manifest V3 extension for Chrome/Edge. Records time on the active tab (idle- and session-aware) and can redirect all browsing to a "blocked" page outside your allowed hours. |
| **Dashboard** | [`dashboard-site/`](dashboard-site) | A static web app (single `index.html`) that visualizes your activity — today's usage, history, top sites, timeline — and edits the tracking/restriction rules. |

Both authenticate with **Firebase Auth** (email + password) and store data in
**Cloud Firestore**. The extension writes activity; the dashboard reads it and
writes settings; the extension polls the settings back and enforces them.

## The "day" boundary

A day is defined as **5:00 AM → 4:59 AM** the next morning, not midnight, so a
late-night session stays attached to the day it started. This shift is applied
consistently in both halves (`FIVE_AM_SHIFT_MS`). The default restriction
window allows browsing 5:00 AM–1:00 AM and blocks 1:00 AM–5:00 AM.

## Data model

Everything lives under a single per-user subtree in Firestore:

```
users/{uid}/
  settings/browserRules      # tracking + restriction settings (one doc)
  siteSegments/{id}          # one doc per continuous visit to a site
  sessions/{id}              # rolled-up browsing sessions
```

Access is scoped per user by [`firestore.rules`](firestore.rules): a signed-in
user can only read and write their own `/users/{uid}` subtree.

## Setup

You need a Firebase project with **Email/Password auth** and **Firestore**
enabled. The repo is currently wired to the `patricks-chrome` project; to use
your own, replace the `firebaseConfig` block in
[`dashboard-site/index.html`](dashboard-site/index.html) and the
`FIREBASE_API_KEY` / `FIREBASE_PROJECT_ID` constants at the top of
[`browser-activity-extension/background.js`](browser-activity-extension/background.js).

> The Firebase web API key is not a secret — it identifies the project, and
> access is enforced by the Firestore security rules, not by hiding the key.

Deploy the security rules once (and the dashboard, if you want Firebase
Hosting):

```bash
firebase deploy --only firestore:rules
firebase deploy --only hosting        # optional; serves dashboard-site/
```

### Install the extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `browser-activity-extension/` folder.
4. Open the popup, sign in with your Firebase account, and browse normally.

### Run the dashboard

`dashboard-site/` is fully static — open `index.html` over any web server (it
loads Firebase from a CDN), or deploy it with Firebase Hosting as above. Sign
in with the **same account** as the extension.

## Privacy

- Tracking can be paused any time from the extension popup or the dashboard.
- **Full URLs** and **page titles** are **off by default** — only the site
  origin (e.g. `https://example.com`) is stored unless you opt in.
- All data stays in your own Firebase project.

## Notes & limitations

- Day boundaries and restriction windows use the **machine's local clock**.
  (An earlier unused `timezone` setting was removed rather than left dangling.)
- Each day supports a **single** allowed-hours window.
- Segments shorter than 5 seconds are discarded to cut noise.
