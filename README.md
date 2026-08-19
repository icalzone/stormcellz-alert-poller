# stormcellz-alert-poller

Polls the National Weather Service's active-alerts feed every 5 minutes and pushes new
severe weather alerts to [StormCellz](https://github.com/) via Firebase Cloud Messaging
topics. No server, no Firestore, no Cloud Functions — this repo's whole job is to run a
free GitHub Actions cron job and call the FCM Admin API directly.

## Why this exists

A previous Firebase-hosted version of this (Cloud Functions + Firestore) got shut down
after an unrelated feature (a persistent WebSocket connection for lightning data) drove up
Cloud Run billing. This repo replaces that architecture entirely: the poll runs on GitHub's
infrastructure (free, unlimited minutes on a public repo), and FCM topic messaging itself
has no usage cap or cost regardless of how many devices are subscribed.

## How it works

1. One HTTP call to `https://api.weather.gov/alerts/active` fetches every active alert in
   the US.
2. Alerts are grouped by a stable hazard key (derived from the NWS VTEC code, so updates to
   the same hazard don't re-notify).
3. New hazards get one FCM push per NWS zone they cover, to the topic `nws_{zone}_{tier}`
   (`tier` is `minor`/`moderate`/`severe`/`extreme`). A device only receives a push if it's
   subscribed to that exact zone+tier topic — the app subscribes to zones for a user's saved
   locations and to every tier at-or-above their chosen alert threshold.
4. Hazards that get cancelled or expire trigger a silent "clear" push so the app can retract
   an already-delivered notification.
5. Which hazards have already been notified on is tracked in `state/seen-hazards.json`,
   committed back to this repo after every run.

## Setup

1. In the Firebase Console for the StormCellz project: **Project Settings → Service
   Accounts → Generate new private key**. This downloads a JSON file.
2. In this repo's GitHub settings: **Settings → Secrets and variables → Actions → New
   repository secret**. Name it `FIREBASE_SERVICE_ACCOUNT`, paste the entire contents of
   the downloaded JSON file as the value.
3. The workflow (`.github/workflows/poll.yml`) runs automatically every 5 minutes. Trigger
   it manually via the Actions tab → "Poll NWS alerts" → "Run workflow" to test.

## Local testing

```
npm install
FIREBASE_SERVICE_ACCOUNT="$(cat path/to/service-account.json)" node poller.js
```

## Notes

- GitHub's cron scheduling is best-effort and can slip by a few minutes under platform
  load — acceptable for a severe-weather feed, worth knowing if you're debugging apparent
  delays.
- `state/seen-hazards.json` is the whole dedup mechanism. If you ever need to force
  re-notification of everything currently active (e.g. after a bug fix), it's safe to
  reset it to `{}`.
